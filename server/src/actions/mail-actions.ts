// Azioni dell'utente sulla posta: effetto locale immediato + attività in coda per il server.

import { resolveByKeep, resolveByMove } from '../ai/auto-sort-log.ts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ulid } from 'ulid';
import { COMPOSE_FONTS, COMPOSE_FONT_SIZES, type AccountDto, type SettingsDto } from '@mmw/shared';
import type { BlobStore } from '../store/blobs.ts';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import { attachments, blobs, conversations, drafts, messageAddresses, messages, notes, projects, suggestions, tasks } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { buildTree, ConversationService } from '../conversations/service.ts';
import { cleanBody, makeSnippet, normalizeSubject } from '../ingest/clean-text.ts';
import { mergeConversations, upsertAddress } from '../ingest/ingest.ts';
import type { ActivityService, SendPayload } from '../activities/service.ts';
import type { ActivityRunner } from '../activities/runner.ts';
import { enqueueSummary } from '../ai/summarize.ts';
import { clearProjectSuggestions, enqueueClassification } from '../ai/classify.ts';
import { clearReplySuggestion, completeReplyTasks } from '../ai/extract-tasks.ts';
import { clearActionSuggestions } from '../ai/suggest-actions.ts';
import { enqueueJob, PRIORITY } from '../jobs/queue.ts';

export const composeSchema = z
  .object({
    projectId: z.string().min(1, 'Serve un progetto'),
    replyToMessageId: z.string().optional(),
    forwardMessageId: z.string().optional(),
    includeQuote: z.boolean().default(false),
    attachments: z
      .array(z.object({ blobSha: z.string().regex(/^[0-9a-f]{64}$/), filename: z.string().min(1).max(255), mime: z.string().nullable() }))
      .default([]),
    to: z.array(z.email('Indirizzo non valido')).default([]),
    cc: z.array(z.email('Indirizzo non valido')).default([]),
    bcc: z.array(z.email('Indirizzo non valido')).default([]),
    subject: z.string().trim().default(''),
    body: z.string().default(''),
    format: z.enum(['text', 'html']).default('text'),
    /** Corpo HTML dall'editor (senza citazione: si aggiunge qui). body è la sua versione in testo. */
    bodyHtml: z.string().nullable().optional(),
    urgent: z.boolean().default(false),
  })
  .refine((c) => c.to.length + c.cc.length + c.bcc.length > 0, { message: 'Serve almeno un destinatario' });

export class ActionError extends Error {}

export interface MailActionsDeps {
  db: Db;
  sqlite: Database.Database;
  activities: ActivityService;
  runner: ActivityRunner;
  getAccount: (id: string) => AccountDto | undefined;
  /** Per le mail HTML (carattere, dimensione) e l'HTML salvato del messaggio in uscita. */
  blobs?: BlobStore;
  getSettings?: () => SettingsDto;
}

export class MailActions {
  private conv: ConversationService;

  constructor(private deps: MailActionsDeps) {
    this.conv = new ConversationService(deps.db);
  }

  /** Apertura di una conversazione: letta subito nell'app, su Gmail al prossimo batch. */
  markRead(conversationId: string): string[] {
    const changed = this.conv.setSeen(this.conv.unreadIncoming(conversationId), true);
    const ids = this.enqueueFlags(conversationId, changed, { add: ['\\Seen'] }, 'Segna come letto');
    if (changed.length) bus.publish({ type: 'conversations', ids: [conversationId] });
    return ids;
  }

  /** Segnalibro "Importante": subito nell'app, su Gmail (\\Flagged) al prossimo batch. */
  setImportant(messageId: string, important: boolean): string[] {
    const msg = this.deps.db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .get();
    if (!msg) throw new ActionError('Messaggio non trovato');
    const changed = this.conv.setImportant([messageId], important);
    const ids = this.enqueueFlags(msg.conversationId, changed, important ? { add: ['\\Flagged'] } : { remove: ['\\Flagged'] }, important ? 'Segna come importante' : 'Togli importante');
    if (changed.length) bus.publish({ type: 'conversations', ids: [msg.conversationId] });
    return ids;
  }

  /** Messaggio aperto nel pannello di lettura: letto subito nell'app, su Gmail al prossimo batch. */
  markMessageRead(messageId: string): string[] {
    const msg = this.deps.db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .get();
    if (!msg) throw new ActionError('Messaggio non trovato');
    const changed = this.conv.setSeen([messageId], true);
    const ids = this.enqueueFlags(msg.conversationId, changed, { add: ['\\Seen'] }, 'Segna come letto');
    if (changed.length) bus.publish({ type: 'conversations', ids: [msg.conversationId] });
    return ids;
  }

  /** "Segna tutto come letto" per una vista: Da smistare, Rumore o un progetto. Un'attività per account. */
  markViewRead(scope: { view: 'inbox' | 'noise' } | { view: 'project'; projectId: string }): { count: number; activityIds: string[] } {
    const { db } = this.deps;
    const where = [
      isNull(conversations.deletedAt),
      isNull(conversations.trashedAt),
      isNull(conversations.archivedAt),
      eq(messages.seen, false),
      eq(messages.direction, 'in'),
      isNull(messages.deletedAt),
    ];
    if (scope.view === 'project') where.push(eq(conversations.projectId, scope.projectId));
    else where.push(isNull(conversations.projectId), eq(conversations.isNoise, scope.view === 'noise'));
    const rows = db
      .select({ id: messages.id, accountId: messages.accountId, conversationId: messages.conversationId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(...where))
      .all();
    if (!rows.length) return { count: 0, activityIds: [] };
    this.conv.setSeen(rows.map((r) => r.id), true);
    const name =
      scope.view === 'project'
        ? (db.select({ n: projects.name }).from(projects).where(eq(projects.id, scope.projectId)).get()?.n ?? 'progetto')
        : scope.view === 'inbox'
          ? 'Da smistare'
          : 'Rumore';
    const activityIds = [...groupBy(rows, (r) => r.accountId)].map(([accountId, list]) =>
      this.deps.activities.enqueue('set_flags', accountId, {
        label: `Segna tutto come letto: ${name} (${list.length})`,
        conversationId: '',
        messageIds: list.map((r) => r.id),
        add: ['\\Seen'],
      }).id,
    );
    bus.publish({ type: 'conversations', ids: [...new Set(rows.map((r) => r.conversationId))] });
    return { count: rows.length, activityIds };
  }

  markUnread(conversationId: string): string[] {
    const last = this.conv.lastIncoming(conversationId);
    const changed = last ? this.conv.setSeen([last], false) : [];
    const ids = this.enqueueFlags(conversationId, changed, { remove: ['\\Seen'] }, 'Segna come non letto');
    if (changed.length) bus.publish({ type: 'conversations', ids: [conversationId] });
    return ids;
  }

  archive(conversationId: string): string[] {
    this.conv.setArchived(conversationId, true);
    clearActionSuggestions(this.deps.db, conversationId);
    const ids = this.enqueuePerAccount(conversationId, 'archive', 'Archivia');
    bus.publish({ type: 'conversations', ids: [conversationId] });
    return ids;
  }

  unarchive(conversationId: string) {
    // M2: togliere dall'archivio è solo locale (su Gmail resta archiviata finché non arriva posta nuova).
    this.conv.setArchived(conversationId, false);
    bus.publish({ type: 'conversations', ids: [conversationId] });
  }

  trash(conversationId: string): string[] {
    this.conv.setTrashed(conversationId, true);
    const ids = this.enqueuePerAccount(conversationId, 'trash', 'Cestina');
    bus.publish({ type: 'conversations', ids: [conversationId] });
    return ids;
  }

  /** È spam: sparisce subito dall'app e, al batch, va nella cartella Spam del server (annullabile fino ad allora). */
  markSpam(conversationId: string): string[] {
    this.deps.db.update(conversations).set({ isSpam: true, updatedAt: now() }).where(eq(conversations.id, conversationId)).run();
    const ids = this.enqueuePerAccount(conversationId, 'spam', 'Segnala come spam');
    bus.publish({ type: 'conversations', ids: [conversationId] });
    return ids;
  }

  move(conversationId: string, projectId: string | null) {
    const res = this.conv.move(conversationId, projectId);
    if (!res) throw new ActionError('Conversazione non trovata');
    // Il progetto ora l'ha scelto l'utente: i suggerimenti in attesa non servono più, e la regola
    // dello smistamento automatico impara se aveva deciso come lui (RF-E6).
    clearProjectSuggestions(this.deps.db, conversationId);
    resolveByMove(this.deps.db, conversationId, projectId);
    this.deps.db.update(conversations).set({ autoSortedAt: null }).where(eq(conversations.id, conversationId)).run();
    clearActionSuggestions(this.deps.db, conversationId, ['noise']);
    if (!projectId) enqueueClassification(this.deps.db, conversationId, PRIORITY.background);
    bus.publish({ type: 'conversations', ids: [conversationId] });
    bus.publish({ type: 'projects' });
    return res;
  }

  /**
   * RF-C5: stacca un messaggio, con le risposte che gli stanno sotto, in una nuova conversazione.
   * Solo locale. La nuova conversazione ricorda da dove viene: le due non si riuniscono più da sole.
   * projectId: undefined = stesso progetto, null = Da smistare.
   */
  detach(messageId: string, projectId?: string | null, withReplies = true): { conversationId: string; fromConversationId: string; moved: number } {
    const { db } = this.deps;
    const m = db.select().from(messages).where(and(eq(messages.id, messageId), isNull(messages.deletedAt))).get();
    if (!m) throw new ActionError('Messaggio non trovato');
    const src = db.select().from(conversations).where(eq(conversations.id, m.conversationId)).get()!;
    const all = db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, src.id), isNull(messages.deletedAt)))
      .orderBy(messages.date)
      .all();
    if (all[0]?.id === m.id) throw new ActionError('È il primo messaggio: la conversazione comincia già da qui');
    if (projectId) {
      const p = db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).get();
      if (!p) throw new ActionError('Progetto non trovato');
    }

    // Il messaggio e tutto il ramo delle sue risposte.
    const parents = buildTree(all);
    const moved = new Set([m.id]);
    for (let grew = withReplies; grew; ) {
      grew = false;
      for (const x of all) {
        const p = parents.get(x.id);
        if (!moved.has(x.id) && p && moved.has(p)) {
          moved.add(x.id);
          grew = true;
        }
      }
    }
    const ids = [...moved];
    const rest = all.filter((x) => !moved.has(x.id));
    const t = now();
    const id = newId();
    const target = projectId === undefined ? src.projectId : projectId;
    db.transaction((tx) => {
      tx.insert(conversations)
        .values({
          id,
          projectId: target,
          subject: normalizeSubject(m.subject) || src.subject,
          lastMessageAt: Math.max(...all.filter((x) => moved.has(x.id)).map((x) => x.date)),
          gmThreadId: src.gmThreadId,
          isNoise: target ? false : src.isNoise,
          classifiedAt: target ? t : null,
          splitFromId: src.id,
          splitAt: t,
          createdAt: t,
          updatedAt: t,
        })
        .run();
      tx.update(messages).set({ conversationId: id, updatedAt: t }).where(inArray(messages.id, ids)).run();
      // Task e note nati da quei messaggi li seguono; così le bozze di risposta.
      tx.update(tasks).set({ conversationId: id, projectId: target ?? undefined, updatedAt: t }).where(inArray(tasks.messageId, ids)).run();
      tx.update(notes).set({ conversationId: id, updatedAt: t }).where(inArray(notes.messageId, ids)).run();
      tx.update(drafts).set({ conversationId: id, updatedAt: t }).where(inArray(drafts.replyToMessageId, ids)).run();
      tx.update(conversations)
        .set({ lastMessageAt: Math.max(...rest.map((x) => x.date)), updatedAt: t })
        .where(eq(conversations.id, src.id))
        .run();
    });
    enqueueSummary(db, src.id);
    enqueueSummary(db, id);
    if (!target) enqueueClassification(db, id, PRIORITY.normal);
    bus.publish({ type: 'conversations', ids: [src.id, id] });
    bus.publish({ type: 'projects' });
    bus.publish({ type: 'tasks' });
    return { conversationId: id, fromConversationId: src.id, moved: ids.length };
  }

  /** Annulla un distacco: la conversazione staccata torna in quella d'origine. */
  /**
   * Unisce conversazioni scelte dall'utente (selezione multipla): devono stare nello stesso posto (stesso
   * progetto, o tutte in Da smistare / News / Spam). Resta quella nata per prima; messaggi, task, note e risorse
   * passano a lei. Le risposte future si agganciano ai messaggi spostati.
   */
  merge(ids: string[]): { conversationId: string } {
    const { db } = this.deps;
    const unique = [...new Set(ids)];
    if (unique.length < 2) throw new ActionError('Servono almeno due conversazioni');
    const rows = db.select().from(conversations).where(and(inArray(conversations.id, unique), isNull(conversations.deletedAt))).all();
    if (rows.length !== unique.length) throw new ActionError('Conversazione non trovata');
    const place = (r: (typeof rows)[number]) => (r.isSpam ? 'spam' : r.projectId ?? (r.isNoise ? 'news' : 'inbox'));
    if (new Set(rows.map(place)).size > 1) throw new ActionError('Si uniscono solo conversazioni dello stesso progetto: sposta prima le altre');
    const target = mergeConversations(db, unique);
    const others = unique.filter((id) => id !== target);
    // Suggerimenti in attesa delle conversazioni che spariscono: non valgono più.
    db.delete(suggestions).where(and(eq(suggestions.subjectType, 'conversation'), inArray(suggestions.subjectId, others), eq(suggestions.status, 'pending'))).run();
    // Basta una aperta perché l'unione resti aperta.
    if (rows.some((r) => !r.archivedAt)) db.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, target)).run();
    // Sintesi rifatta subito (azione dell'utente: anche con l'analisi in pausa).
    db.update(conversations).set({ summaryUpdatedAt: null }).where(eq(conversations.id, target)).run();
    enqueueJob(db, 'summarize', { conversationId: target }, PRIORITY.focus + 3);
    bus.publish({ type: 'conversations', ids: unique });
    bus.publish({ type: 'projects' });
    bus.publish({ type: 'tasks' });
    return { conversationId: target };
  }

  rejoin(conversationId: string): { conversationId: string } {
    const { db } = this.deps;
    const c = db.select().from(conversations).where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt))).get();
    if (!c?.splitFromId) throw new ActionError('Questa conversazione non è stata staccata da un\'altra');
    const origin = db.select().from(conversations).where(and(eq(conversations.id, c.splitFromId), isNull(conversations.deletedAt))).get();
    if (!origin) throw new ActionError('La conversazione d\'origine non esiste più');
    const target = mergeConversations(db, [origin.id, c.id]);
    const gone = target === origin.id ? c.id : origin.id;
    // Chi era stato staccato da quella che sparisce ora punta alla conversazione unita.
    db.update(conversations).set({ splitFromId: origin.splitFromId }).where(eq(conversations.id, target)).run();
    db.update(conversations).set({ splitFromId: target }).where(and(eq(conversations.splitFromId, gone), isNull(conversations.deletedAt))).run();
    enqueueSummary(db, target);
    bus.publish({ type: 'conversations', ids: [origin.id, c.id] });
    bus.publish({ type: 'projects' });
    return { conversationId: target };
  }

  /** Conversazione smistata da sola, vista e tenuta lì: il segno sparisce e la regola aveva ragione. */
  keepAutoSort(conversationId: string) {
    const c = this.deps.db.select({ at: conversations.autoSortedAt }).from(conversations).where(eq(conversations.id, conversationId)).get();
    if (!c?.at) return;
    resolveByKeep(this.deps.db, conversationId);
    this.deps.db.update(conversations).set({ autoSortedAt: null }).where(eq(conversations.id, conversationId)).run();
    bus.publish({ type: 'conversations', ids: [conversationId] });
  }

  /** Nuova email o risposta, sempre da un progetto: il mittente è l'account del progetto. */
  compose(raw: z.input<typeof composeSchema>): { activityId: string; conversationId: string; messageId: string } {
    const input = composeSchema.parse(raw);
    const { db, sqlite } = this.deps;
    const project = db
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt)))
      .get();
    if (!project) throw new ActionError('Progetto non trovato');
    const account = this.deps.getAccount(project.outgoingAccountId);
    if (!account) throw new ActionError("L'account di uscita del progetto non esiste più");

    const parent = input.replyToMessageId
      ? db.select().from(messages).where(and(eq(messages.id, input.replyToMessageId), isNull(messages.deletedAt))).get()
      : undefined;
    if (input.replyToMessageId && !parent) throw new ActionError('Messaggio a cui rispondere non trovato');

    const forwarded = input.forwardMessageId
      ? db.select().from(messages).where(and(eq(messages.id, input.forwardMessageId), isNull(messages.deletedAt))).get()
      : undefined;
    if (input.forwardMessageId && !forwarded) throw new ActionError('Messaggio da inoltrare non trovato');

    const t = now();
    const domain = account.email.split('@')[1] ?? 'localhost';
    const rfcMessageId = `<${ulid().toLowerCase()}@${domain}>`;
    const references = parent
      ? [...(JSON.parse(parent.references ?? '[]') as string[]), parent.rfcMessageId].filter((x): x is string => !!x).slice(-20)
      : [];
    const subject =
      input.subject || (parent ? `Re: ${normalizeSubject(parent.subject)}` : forwarded ? `Fwd: ${normalizeSubject(forwarded.subject)}` : '');
    // Il testo citato (risposta) o il messaggio inoltrato si aggiungono in fondo, al momento dell'invio.
    let fullBody = input.body;
    if (parent && input.includeQuote) fullBody += quoteBlock(parent);
    if (forwarded) fullBody += forwardBlock(forwarded);
    // Versione HTML: corpo dall'editor + citazione/inoltro, nel carattere scelto nelle impostazioni.
    let fullHtml: string | null = null;
    if (input.format === 'html' && input.bodyHtml != null) {
      let inner = input.bodyHtml;
      if (parent && input.includeQuote) inner += quoteHtml(parent);
      if (forwarded) inner += forwardHtml(forwarded);
      fullHtml = wrapHtml(inner, this.deps.getSettings?.());
    }
    const bodyTextClean = cleanBody(input.body);
    // Inoltro: si portano dietro gli allegati del messaggio originale.
    const outgoing = [...input.attachments];
    if (forwarded) {
      for (const a of db.select().from(attachments).where(and(eq(attachments.messageId, forwarded.id), eq(attachments.isInline, false))).all()) {
        outgoing.push({ blobSha: a.blobSha, filename: a.filename ?? 'allegato', mime: a.mime });
      }
    }

    const result = db.transaction((tx) => {
      let conversationId: string;
      let createdConversation = false;
      if (parent) {
        conversationId = parent.conversationId;
        // Rispondere da un progetto porta la conversazione nel progetto.
        tx.update(conversations)
          .set({ projectId: project.id, isNoise: false, archivedAt: null, trashedAt: null, updatedAt: t })
          .where(eq(conversations.id, conversationId))
          .run();
      } else {
        conversationId = newId();
        createdConversation = true;
        tx.insert(conversations)
          .values({
            id: conversationId,
            projectId: project.id,
            subject: normalizeSubject(subject) || null,
            lastMessageAt: t,
            createdAt: t,
            updatedAt: t,
          })
          .run();
      }

      const messageId = newId();
      tx.insert(messages)
        .values({
          id: messageId,
          conversationId,
          accountId: account.id,
          direction: 'out',
          rfcMessageId,
          inReplyTo: parent?.rfcMessageId ?? null,
          references: JSON.stringify(references),
          fromAddress: account.email.toLowerCase(),
          fromName: account.name,
          subject,
          date: t,
          snippet: makeSnippet(bodyTextClean || input.body),
          bodyText: fullBody,
          bodyTextClean,
          flags: JSON.stringify(['\\Seen']),
          labels: JSON.stringify([]),
          seen: true,
          hasAttachments: outgoing.length > 0,
          htmlBlobSha: fullHtml && this.deps.blobs ? this.deps.blobs.put(Buffer.from(fullHtml, 'utf8'), 'text/html') : null,
          outgoingStatus: 'queued',
          createdAt: t,
          updatedAt: t,
        })
        .run();

      for (const a of outgoing) {
        const blob = tx.select().from(blobs).where(eq(blobs.sha256, a.blobSha)).get();
        if (!blob) throw new ActionError(`Allegato non trovato: ${a.filename}`);
        tx.insert(attachments)
          .values({ id: newId(), messageId, blobSha: a.blobSha, filename: a.filename, mime: a.mime, size: blob.size, createdAt: t })
          .run();
      }

      const roles = [
        [[account.email.toLowerCase()], 'from'],
        [input.to, 'to'],
        [input.cc, 'cc'],
        [input.bcc, 'bcc'],
      ] as const;
      for (const [list, role] of roles) {
        for (const email of list) {
          const addressId = upsertAddress(tx as unknown as Db, { name: null, email: email.toLowerCase() }, t);
          tx.insert(messageAddresses).values({ messageId, contactAddressId: addressId, role }).onConflictDoNothing().run();
        }
      }
      sqlite
        .prepare('insert into message_fts(message_id, subject, body, participants) values (?, ?, ?, ?)')
        .run(messageId, subject, bodyTextClean || input.body, [...input.to, ...input.cc].join(' '));
      tx.update(conversations)
        .set({ lastMessageAt: sql`max(${conversations.lastMessageAt}, ${t})`, updatedAt: t })
        .where(eq(conversations.id, conversationId))
        .run();

      const payload: SendPayload = {
        label: `Invio: ${subject || '(nessun oggetto)'} → ${[...input.to, ...input.cc].join(', ')}`,
        conversationId,
        messageId,
        createdConversation,
        // Il nome dell'account è il nome visibile del mittente ("Luca <lucadevzone@gmail.com>").
        fromName: account.name,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject,
        body: fullBody,
        html: fullHtml,
        inReplyTo: parent?.rfcMessageId ?? null,
        references,
        attachments: outgoing,
        draft: {
          projectId: project.id,
          replyToMessageId: parent?.id ?? null,
          forwardMessageId: forwarded?.id ?? null,
          includeQuote: input.includeQuote,
          body: input.body,
          format: input.format,
          bodyHtml: input.bodyHtml ?? null,
          attachments: input.attachments,
        },
      };
      const activity = this.deps.activities.enqueue('send', account.id, payload, input.urgent);
      return { activityId: activity.id, conversationId, messageId };
    });

    bus.publish({ type: 'conversations', ids: [result.conversationId] });
    bus.publish({ type: 'projects' });
    enqueueSummary(db, result.conversationId);
    clearReplySuggestion(db, result.conversationId);
    clearActionSuggestions(db, result.conversationId);
    completeReplyTasks(db, result.conversationId, now() + 1);
    if (input.urgent) void this.deps.runner.run([result.activityId]);
    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private enqueueFlags(conversationId: string, messageIds: string[], op: { add?: string[]; remove?: string[] }, verb: string) {
    if (!messageIds.length) return [];
    const rows = this.deps.db
      .select({ id: messages.id, accountId: messages.accountId })
      .from(messages)
      .where(inArray(messages.id, messageIds))
      .all();
    const subject = this.subjectOf(conversationId);
    return [...groupBy(rows, (r) => r.accountId)].map(([accountId, list]) =>
      this.deps.activities.enqueue('set_flags', accountId, {
        label: `${verb}: ${subject}`,
        conversationId,
        messageIds: list.map((r) => r.id),
        ...op,
      }).id,
    );
  }

  private enqueuePerAccount(conversationId: string, kind: 'archive' | 'trash' | 'spam', verb: string): string[] {
    const accountIds = new Set(
      this.deps.db
        .select({ accountId: messages.accountId })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
        .all()
        .map((m) => m.accountId),
    );
    const subject = this.subjectOf(conversationId);
    return [...accountIds].map(
      (accountId) => this.deps.activities.enqueue(kind, accountId, { label: `${verb}: ${subject}`, conversationId }).id,
    );
  }

  private subjectOf(conversationId: string): string {
    return (
      this.deps.db.select({ s: conversations.subject }).from(conversations).where(eq(conversations.id, conversationId)).get()?.s ||
      '(nessun oggetto)'
    );
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

const quoteDate = (ms: number) => new Date(ms).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Testo citato in coda alla risposta. */
export function quoteBlock(m: { date: number; fromName: string | null; fromAddress: string | null; bodyText: string | null; bodyTextClean: string | null }): string {
  const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : (m.fromAddress ?? 'qualcuno');
  const text = (m.bodyTextClean || m.bodyText || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\nIl ${quoteDate(m.date)}, ${who} ha scritto:\n${text}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textToHtml = (s: string) => escapeHtml(s).replace(/\r?\n/g, '<br>');

/** Citazione in HTML: intestazione e testo originale in un blockquote (come Gmail). */
export function quoteHtml(m: { date: number; fromName: string | null; fromAddress: string | null; bodyText: string | null; bodyTextClean: string | null }): string {
  const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : (m.fromAddress ?? 'qualcuno');
  return (
    `<br><div>Il ${escapeHtml(quoteDate(m.date))}, ${escapeHtml(who)} ha scritto:</div>` +
    `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(m.bodyTextClean || m.bodyText || '')}</blockquote>`
  );
}

export function forwardHtml(m: { date: number; fromName: string | null; fromAddress: string | null; subject: string | null; bodyText: string | null }): string {
  const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : (m.fromAddress ?? '');
  return (
    `<br><div>---------- Messaggio inoltrato ----------<br>Da: ${escapeHtml(who)}<br>Data: ${escapeHtml(quoteDate(m.date))}<br>` +
    `Oggetto: ${escapeHtml(m.subject ?? '')}</div><br><div>${textToHtml(m.bodyText ?? '')}</div>`
  );
}

/** Documento HTML della mail, con il carattere delle impostazioni. */
export function wrapHtml(inner: string, s?: Pick<SettingsDto, 'composeFont' | 'composeFontSize'>): string {
  const font = COMPOSE_FONTS[s?.composeFont ?? 'sans'].css;
  const size = COMPOSE_FONT_SIZES[s?.composeFontSize ?? 'normal'].css;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font-family:${font};font-size:${size}">${inner}</div></body></html>`;
}

/** Intestazione e testo del messaggio inoltrato. */
export function forwardBlock(m: { date: number; fromName: string | null; fromAddress: string | null; subject: string | null; bodyText: string | null }): string {
  const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : (m.fromAddress ?? '');
  return `\n\n---------- Messaggio inoltrato ----------\nDa: ${who}\nData: ${quoteDate(m.date)}\nOggetto: ${m.subject ?? ''}\n\n${m.bodyText ?? ''}`;
}
