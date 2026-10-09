import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type {
  AttachmentDto,
  ConversationDetail,
  ConversationListItem,
  ConversationQuery,
  MessageDto,
  PersonRef,
  SuggestionDto,
} from '@mmw/shared';
import type { Db } from '../db/client.ts';
import {
  accounts,
  attachments,
  blobs,
  drafts,
  contactAddresses,
  conversations,
  messageAddresses,
  messages,
  notes,
  projects,
  resources,
  suggestions,
  tasks,
} from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import { buildFileHistory, normalizeFileName, versionIndex } from './versions.ts';

export class ConversationService {
  constructor(private db: Db) {}

  private ownAddresses(): Set<string> {
    return new Set(
      this.db
        .select({ email: accounts.email })
        .from(accounts)
        .where(isNull(accounts.deletedAt))
        .all()
        .map((a) => a.email.toLowerCase()),
    );
  }

  /** personAddressIds: indirizzi della persona di q.person, risolti dal chiamante (PeopleService). */
  list(q: ConversationQuery & { limit?: number; personAddressIds?: string[] }): ConversationListItem[] {
    const limit = Math.min(q.limit ?? 50, 200);
    const where = [isNull(conversations.deletedAt), isNull(conversations.trashedAt)];
    if (q.view === 'project') {
      if (!q.projectId) return [];
      where.push(eq(conversations.projectId, q.projectId));
    } else if (q.view === 'person') {
      if (!q.person) return [];
    } else {
      where.push(isNull(conversations.projectId), eq(conversations.isNoise, q.view === 'noise'));
    }
    if (q.person) {
      const ids = q.personAddressIds ?? [];
      if (!ids.length) return [];
      where.push(
        inArray(
          conversations.id,
          this.db
            .select({ id: messages.conversationId })
            .from(messages)
            .innerJoin(messageAddresses, eq(messageAddresses.messageId, messages.id))
            .where(and(inArray(messageAddresses.contactAddressId, ids), isNull(messages.deletedAt))),
        ),
      );
    }
    // Nella vista persona si mostrano anche le archiviate: è uno storico dei rapporti.
    if (q.view !== 'person') where.push(q.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt));
    if (q.before) where.push(lt(conversations.lastMessageAt, q.before));

    const rows = this.db
      .select()
      .from(conversations)
      .where(and(...where))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(limit)
      .all();
    return this.decorate(rows);
  }

  private decorate(rows: (typeof conversations.$inferSelect)[]): ConversationListItem[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);

    const stats = this.db
      .select({
        conversationId: messages.conversationId,
        count: sql<number>`count(*)`,
        unread: sql<number>`sum(case when ${messages.seen} = 0 and ${messages.direction} = 'in' then 1 else 0 end)`,
        attachments: sql<number>`max(${messages.hasAttachments})`,
        important: sql<number>`max(${messages.important})`,
        accountIds: sql<string>`group_concat(distinct ${messages.accountId})`,
      })
      .from(messages)
      .where(and(inArray(messages.conversationId, ids), isNull(messages.deletedAt)))
      .groupBy(messages.conversationId)
      .all();
    const statsById = new Map(stats.map((s) => [s.conversationId, s]));

    // Numero di file distinti per conversazione (le versioni di uno stesso file contano una volta).
    const fileNames = new Map<string, Set<string>>();
    for (const r of this.db
      .select({ c: messages.conversationId, filename: attachments.filename })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(and(inArray(messages.conversationId, ids), isNull(messages.deletedAt), eq(attachments.isInline, false)))
      .all()) {
      fileNames.set(r.c, (fileNames.get(r.c) ?? new Set()).add(normalizeFileName(r.filename)));
    }
    const pending = this.pendingSuggestions(ids);
    const draftConvs = new Set(
      this.db.select({ c: drafts.conversationId }).from(drafts).where(inArray(drafts.conversationId, ids)).all().map((r) => r.c),
    );
    const taskCounts = new Map(
      this.db
        .select({ c: tasks.conversationId, n: sql<number>`count(*)` })
        .from(tasks)
        .where(and(inArray(tasks.conversationId, ids), eq(tasks.status, 'open'), isNull(tasks.deletedAt)))
        .groupBy(tasks.conversationId)
        .all()
        .map((r) => [r.c, r.n]),
    );
    const noteCounts = new Map(
      this.db
        .select({ c: notes.conversationId, n: sql<number>`count(*)` })
        .from(notes)
        .where(and(inArray(notes.conversationId, ids), isNull(notes.deletedAt)))
        .groupBy(notes.conversationId)
        .all()
        .map((r) => [r.c, r.n]),
    );
    const resourceCounts = new Map(
      this.db
        .select({ c: resources.conversationId, n: sql<number>`count(*)` })
        .from(resources)
        .where(and(inArray(resources.conversationId, ids), isNull(resources.deletedAt)))
        .groupBy(resources.conversationId)
        .all()
        .map((r) => [r.c, r.n]),
    );

    // Snippet dell'ultimo messaggio di ogni conversazione.
    const last = this.db
      .select({ conversationId: messages.conversationId, snippet: messages.snippet, date: messages.date })
      .from(messages)
      .where(and(inArray(messages.conversationId, ids), isNull(messages.deletedAt)))
      .orderBy(desc(messages.date))
      .all();
    const snippetById = new Map<string, string | null>();
    for (const m of last) if (!snippetById.has(m.conversationId)) snippetById.set(m.conversationId, m.snippet);

    const own = this.ownAddresses();
    const people = this.db
      .select({
        conversationId: messages.conversationId,
        email: contactAddresses.email,
        name: contactAddresses.displayName,
        date: messages.date,
      })
      .from(messageAddresses)
      .innerJoin(messages, eq(messages.id, messageAddresses.messageId))
      .innerJoin(contactAddresses, eq(contactAddresses.id, messageAddresses.contactAddressId))
      .where(and(inArray(messages.conversationId, ids), isNull(messages.deletedAt)))
      .orderBy(desc(messages.date))
      .all();
    const peopleById = new Map<string, PersonRef[]>();
    for (const p of people) {
      if (own.has(p.email)) continue;
      const list = peopleById.get(p.conversationId) ?? [];
      if (!list.some((x) => x.email === p.email)) list.push({ name: p.name, email: p.email });
      peopleById.set(p.conversationId, list);
    }

    return rows.map((r) => {
      const s = statsById.get(r.id);
      return {
        id: r.id,
        subject: r.subject,
        summary: r.summary,
        summaryDetailed: r.summaryDetailed,
        snippet: snippetById.get(r.id) ?? null,
        lastMessageAt: r.lastMessageAt,
        messageCount: s?.count ?? 0,
        unreadCount: s?.unread ?? 0,
        hasAttachments: !!s?.attachments,
        important: !!s?.important,
        hasDraft: draftConvs.has(r.id),
        attachmentCount: fileNames.get(r.id)?.size ?? 0,
        taskCount: taskCounts.get(r.id) ?? 0,
        noteCount: noteCounts.get(r.id) ?? 0,
        resourceCount: resourceCounts.get(r.id) ?? 0,
        isNoise: r.isNoise,
        projectId: r.projectId,
        archived: r.archivedAt != null,
        suggestions: pending.get(r.id) ?? [],
        participants: peopleById.get(r.id) ?? [],
        accountIds: s?.accountIds ? s.accountIds.split(',') : [],
      };
    });
  }

  /** Suggerimenti in attesa per queste conversazioni, dal più sicuro. */
  private pendingSuggestions(ids: string[]): Map<string, SuggestionDto[]> {
    const out = new Map<string, SuggestionDto[]>();
    const rows = this.db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.subjectType, 'conversation'), inArray(suggestions.subjectId, ids), eq(suggestions.status, 'pending')))
      .orderBy(desc(suggestions.confidence))
      .all();
    for (const r of rows) {
      out.set(r.subjectId, [
        ...(out.get(r.subjectId) ?? []),
        { id: r.id, kind: r.kind, confidence: r.confidence, payload: JSON.parse(r.payload), createdAt: r.createdAt },
      ]);
    }
    return out;
  }

  private inboxBase() {
    return [
      isNull(conversations.deletedAt),
      isNull(conversations.projectId),
      isNull(conversations.trashedAt),
      isNull(conversations.archivedAt),
    ];
  }

  /** Messaggi non letti: Da smistare, Rumore e totale fuori dal rumore (Da smistare + progetti attivi). */
  counts(): { inbox: number; noise: number; inboxUnread: number; noiseUnread: number; totalUnread: number } {
    const row = this.db
      .select({
        inbox: sql<number>`coalesce(sum(case when ${conversations.isNoise} = 0 then 1 else 0 end), 0)`,
        noise: sql<number>`coalesce(sum(case when ${conversations.isNoise} = 1 then 1 else 0 end), 0)`,
      })
      .from(conversations)
      .where(and(...this.inboxBase()))
      .get();
    const unread = this.db
      .select({
        inbox: sql<number>`coalesce(sum(case when ${conversations.projectId} is null and ${conversations.isNoise} = 0 then 1 else 0 end), 0)`,
        noise: sql<number>`coalesce(sum(case when ${conversations.projectId} is null and ${conversations.isNoise} = 1 then 1 else 0 end), 0)`,
        total: sql<number>`coalesce(sum(case when ${conversations.isNoise} = 0 and (${conversations.projectId} is null or ${projects.archived} = 0) then 1 else 0 end), 0)`,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(projects, eq(projects.id, conversations.projectId))
      .where(
        and(
          isNull(conversations.deletedAt),
          isNull(conversations.trashedAt),
          isNull(conversations.archivedAt),
          eq(messages.seen, false),
          eq(messages.direction, 'in'),
          isNull(messages.deletedAt),
        ),
      )
      .get();
    return {
      inbox: row?.inbox ?? 0,
      noise: row?.noise ?? 0,
      inboxUnread: unread?.inbox ?? 0,
      noiseUnread: unread?.noise ?? 0,
      totalUnread: unread?.total ?? 0,
    };
  }

  get(id: string): ConversationDetail | undefined {
    const conv = this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .get();
    if (!conv) return undefined;

    const msgs = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), isNull(messages.deletedAt)))
      .orderBy(messages.date)
      .all();
    const ids = msgs.map((m) => m.id);

    const addrs = ids.length
      ? this.db
          .select({
            messageId: messageAddresses.messageId,
            role: messageAddresses.role,
            email: contactAddresses.email,
            name: contactAddresses.displayName,
          })
          .from(messageAddresses)
          .innerJoin(contactAddresses, eq(contactAddresses.id, messageAddresses.contactAddressId))
          .where(inArray(messageAddresses.messageId, ids))
          .all()
      : [];
    const atts = ids.length ? this.db.select().from(attachments).where(inArray(attachments.messageId, ids)).all() : [];

    const toPerson = (a: { email: string; name: string | null }): PersonRef => ({ name: a.name, email: a.email });
    const parents = buildTree(msgs);
    const noteRows = this.db
      .select()
      .from(notes)
      .where(and(eq(notes.conversationId, id), isNull(notes.deletedAt)))
      .orderBy(desc(notes.updatedAt))
      .all();
    const resourceRows = this.db
      .select({ r: resources, size: blobs.size, mime: blobs.mime })
      .from(resources)
      .leftJoin(blobs, eq(blobs.sha256, resources.blobSha))
      .where(and(eq(resources.conversationId, id), isNull(resources.deletedAt)))
      .orderBy(desc(resources.createdAt))
      .all();
    const msgById = new Map(msgs.map((m) => [m.id, m]));
    const files = buildFileHistory(
      atts
        .filter((a) => !a.isInline)
        .map((a) => {
          const m = msgById.get(a.messageId)!;
          return {
            id: a.id,
            filename: a.filename,
            mime: a.mime,
            size: a.size,
            blobSha: a.blobSha,
            messageId: a.messageId,
            date: m.date,
            from: m.fromAddress ? { name: m.fromName, email: m.fromAddress } : null,
          };
        }),
    );
    const versionOf = versionIndex(files);

    return {
      id: conv.id,
      subject: conv.subject,
      projectId: conv.projectId,
      isNoise: conv.isNoise,
      archived: conv.archivedAt != null,
      summary: conv.summary,
      summaryDetailed: conv.summaryDetailed,
      files,
      notes: noteRows.map((n) => ({
        id: n.id,
        conversationId: n.conversationId,
        projectId: n.projectId,
        body: n.body,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
      resources: resourceRows.map(({ r, size, mime }) => ({
        id: r.id,
        conversationId: r.conversationId,
        projectId: r.projectId,
        kind: r.kind,
        title: r.title,
        url: r.url,
        size,
        mime,
        createdAt: r.createdAt,
      })),
      messages: msgs.map(
        (m): MessageDto => ({
          id: m.id,
          parentId: parents.get(m.id) ?? null,
          accountId: m.accountId,
          direction: m.direction,
          // Il nome mostrato è quello dell'header del messaggio, non quello salvato sull'indirizzo.
          from: m.fromAddress ? { name: m.fromName, email: m.fromAddress } : null,
          to: addrs.filter((a) => a.messageId === m.id && a.role === 'to').map(toPerson),
          cc: addrs.filter((a) => a.messageId === m.id && a.role === 'cc').map(toPerson),
          date: m.date,
          subject: m.subject,
          bodyText: m.bodyText,
          bodyTextClean: m.bodyTextClean,
          hasHtml: !!m.htmlBlobSha,
          seen: m.seen,
          important: m.important,
          outgoingStatus: m.outgoingStatus,
          attachments: atts
            .filter((a) => a.messageId === m.id)
            .map(
              (a): AttachmentDto => ({
                id: a.id,
                filename: a.filename,
                mime: a.mime,
                size: a.size,
                isInline: a.isInline,
                ...versionOf.get(a.id),
              }),
            ),
        }),
      ),
    };
  }

  /** Sposta una conversazione (con note, task e risorse collegati) in un progetto o in Da smistare. */
  move(id: string, projectId: string | null): { previousProjectId: string | null } | undefined {
    const conv = this.db
      .select({ projectId: conversations.projectId })
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .get();
    if (!conv) return undefined;
    if (projectId) {
      const p = this.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
        .get();
      if (!p) throw new Error('Progetto inesistente');
    }
    const t = now();
    this.db.transaction((tx) => {
      // Assegnare un progetto toglie anche il marchio di rumore: è una scelta esplicita dell'utente.
      tx.update(conversations)
        .set({ projectId, ...(projectId ? { isNoise: false } : {}), updatedAt: t })
        .where(eq(conversations.id, id))
        .run();
      for (const table of [notes, tasks, resources]) {
        tx.update(table).set({ projectId, updatedAt: t }).where(eq(table.conversationId, id)).run();
      }
    });
    return { previousProjectId: conv.projectId };
  }

  setArchived(id: string, archived: boolean) {
    this.db
      .update(conversations)
      .set({ archivedAt: archived ? now() : null, updatedAt: now() })
      .where(eq(conversations.id, id))
      .run();
  }

  setTrashed(id: string, trashed: boolean) {
    this.db
      .update(conversations)
      .set({ trashedAt: trashed ? now() : null, updatedAt: now() })
      .where(eq(conversations.id, id))
      .run();
  }

  /** Messaggi della conversazione presenti sul server (con UID). */
  serverMessageIds(id: string): string[] {
    return this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, id), isNull(messages.deletedAt), isNotNull(messages.uid)))
      .all()
      .map((m) => m.id);
  }

  /** Imposta lo stato di lettura locale; restituisce i messaggi effettivamente cambiati. */
  setSeen(messageIds: string[], seen: boolean): string[] {
    if (!messageIds.length) return [];
    const changed = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(inArray(messages.id, messageIds), eq(messages.seen, !seen)))
      .all()
      .map((m) => m.id);
    if (changed.length) {
      this.db.update(messages).set({ seen, updatedAt: now() }).where(inArray(messages.id, changed)).run();
    }
    return changed;
  }

  setImportant(messageIds: string[], important: boolean): string[] {
    if (!messageIds.length) return [];
    const changed = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(inArray(messages.id, messageIds), eq(messages.important, !important)))
      .all()
      .map((m) => m.id);
    if (changed.length) this.db.update(messages).set({ important, updatedAt: now() }).where(inArray(messages.id, changed)).run();
    return changed;
  }

  unreadIncoming(id: string): string[] {
    return this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          isNull(messages.deletedAt),
          eq(messages.seen, false),
          eq(messages.direction, 'in'),
        ),
      )
      .all()
      .map((m) => m.id);
  }

  lastIncoming(id: string): string | undefined {
    return this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, id), isNull(messages.deletedAt), eq(messages.direction, 'in')))
      .orderBy(desc(messages.date))
      .get()?.id;
  }

  setNoise(id: string, isNoise: boolean): boolean {
    const res = this.db
      .update(conversations)
      .set({ isNoise, updatedAt: now() })
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .run();
    return res.changes > 0;
  }
}

/**
 * Albero delle risposte: il padre è il messaggio citato in In-Reply-To (o l'ultimo dei References)
 * presente nella conversazione; se manca, il primo messaggio (la radice).
 */
export function buildTree(msgs: { id: string; rfcMessageId: string | null; inReplyTo: string | null; references: string | null }[]): Map<string, string | null> {
  const byRfc = new Map(msgs.filter((m) => m.rfcMessageId).map((m) => [m.rfcMessageId!, m.id]));
  const root = msgs[0]?.id ?? null;
  const out = new Map<string, string | null>();
  for (const m of msgs) {
    if (m.id === root) {
      out.set(m.id, null);
      continue;
    }
    const refs = [m.inReplyTo, ...[...(JSON.parse(m.references ?? '[]') as string[])].reverse()];
    const parent = refs.map((r) => (r ? byRfc.get(r) : undefined)).find((id) => id && id !== m.id);
    out.set(m.id, parent ?? root);
  }
  return out;
}
