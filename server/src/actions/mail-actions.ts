// Azioni dell'utente sulla posta: effetto locale immediato + attività in coda per il server.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { AccountDto } from '@mmw/shared';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import { conversations, messageAddresses, messages, projects } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { ConversationService } from '../conversations/service.ts';
import { cleanBody, makeSnippet, normalizeSubject } from '../ingest/clean-text.ts';
import { upsertAddress } from '../ingest/ingest.ts';
import type { ActivityService, SendPayload } from '../activities/service.ts';
import type { ActivityRunner } from '../activities/runner.ts';
import { enqueueSummary } from '../ai/summarize.ts';
import { clearProjectSuggestions, enqueueClassification } from '../ai/classify.ts';
import { clearReplySuggestion, completeReplyTasks } from '../ai/extract-tasks.ts';
import { clearActionSuggestions } from '../ai/suggest-actions.ts';
import { PRIORITY } from '../jobs/queue.ts';

export const composeSchema = z
  .object({
    projectId: z.string().min(1, 'Serve un progetto'),
    replyToMessageId: z.string().optional(),
    to: z.array(z.email('Indirizzo non valido')).default([]),
    cc: z.array(z.email('Indirizzo non valido')).default([]),
    bcc: z.array(z.email('Indirizzo non valido')).default([]),
    subject: z.string().trim().default(''),
    body: z.string().default(''),
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

  move(conversationId: string, projectId: string | null) {
    const res = this.conv.move(conversationId, projectId);
    if (!res) throw new ActionError('Conversazione non trovata');
    // Il progetto ora l'ha scelto l'utente: i suggerimenti in attesa non servono più.
    clearProjectSuggestions(this.deps.db, conversationId);
    clearActionSuggestions(this.deps.db, conversationId, ['noise']);
    if (!projectId) enqueueClassification(this.deps.db, conversationId, PRIORITY.background);
    bus.publish({ type: 'conversations', ids: [conversationId] });
    bus.publish({ type: 'projects' });
    return res;
  }

  /** Nuova email o risposta, sempre da un progetto: il mittente è l'account del progetto. */
  compose(input: z.infer<typeof composeSchema>): { activityId: string; conversationId: string; messageId: string } {
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

    const t = now();
    const domain = account.email.split('@')[1] ?? 'localhost';
    const rfcMessageId = `<${ulid().toLowerCase()}@${domain}>`;
    const references = parent
      ? [...(JSON.parse(parent.references ?? '[]') as string[]), parent.rfcMessageId].filter((x): x is string => !!x).slice(-20)
      : [];
    const subject = input.subject || (parent ? `Re: ${normalizeSubject(parent.subject)}` : '');
    const bodyTextClean = cleanBody(input.body);

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
          bodyText: input.body,
          bodyTextClean,
          flags: JSON.stringify(['\\Seen']),
          labels: JSON.stringify([]),
          seen: true,
          outgoingStatus: 'queued',
          createdAt: t,
          updatedAt: t,
        })
        .run();

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
        body: input.body,
        inReplyTo: parent?.rfcMessageId ?? null,
        references,
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

  private enqueuePerAccount(conversationId: string, kind: 'archive' | 'trash', verb: string): string[] {
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
