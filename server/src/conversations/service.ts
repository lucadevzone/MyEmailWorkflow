import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type {
  AttachmentDto,
  ConversationDetail,
  ConversationListItem,
  ConversationQuery,
  MessageDto,
  PersonRef,
} from '@mmw/shared';
import type { Db } from '../db/client.ts';
import {
  accounts,
  attachments,
  contactAddresses,
  conversations,
  messageAddresses,
  messages,
  notes,
  projects,
  resources,
  tasks,
} from '../db/schema.ts';
import { now } from '../lib/ids.ts';

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

  list(q: ConversationQuery & { limit?: number }): ConversationListItem[] {
    const limit = Math.min(q.limit ?? 50, 200);
    const where = [isNull(conversations.deletedAt), isNull(conversations.trashedAt)];
    if (q.view === 'project') {
      if (!q.projectId) return [];
      where.push(eq(conversations.projectId, q.projectId));
    } else {
      where.push(isNull(conversations.projectId), eq(conversations.isNoise, q.view === 'noise'));
    }
    where.push(q.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt));
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
        accountIds: sql<string>`group_concat(distinct ${messages.accountId})`,
      })
      .from(messages)
      .where(and(inArray(messages.conversationId, ids), isNull(messages.deletedAt)))
      .groupBy(messages.conversationId)
      .all();
    const statsById = new Map(stats.map((s) => [s.conversationId, s]));

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
        snippet: snippetById.get(r.id) ?? null,
        lastMessageAt: r.lastMessageAt,
        messageCount: s?.count ?? 0,
        unreadCount: s?.unread ?? 0,
        hasAttachments: !!s?.attachments,
        isNoise: r.isNoise,
        projectId: r.projectId,
        archived: r.archivedAt != null,
        participants: peopleById.get(r.id) ?? [],
        accountIds: s?.accountIds ? s.accountIds.split(',') : [],
      };
    });
  }

  private inboxBase() {
    return [
      isNull(conversations.deletedAt),
      isNull(conversations.projectId),
      isNull(conversations.trashedAt),
      isNull(conversations.archivedAt),
    ];
  }

  counts(): { inbox: number; noise: number; inboxUnread: number } {
    const row = this.db
      .select({
        inbox: sql<number>`sum(case when ${conversations.isNoise} = 0 then 1 else 0 end)`,
        noise: sql<number>`sum(case when ${conversations.isNoise} = 1 then 1 else 0 end)`,
      })
      .from(conversations)
      .where(and(...this.inboxBase()))
      .get();
    const unread = this.db
      .select({ n: sql<number>`count(distinct ${conversations.id})` })
      .from(conversations)
      .innerJoin(messages, eq(messages.conversationId, conversations.id))
      .where(
        and(
          ...this.inboxBase(),
          eq(conversations.isNoise, false),
          eq(messages.seen, false),
          eq(messages.direction, 'in'),
          isNull(messages.deletedAt),
        ),
      )
      .get();
    return { inbox: row?.inbox ?? 0, noise: row?.noise ?? 0, inboxUnread: unread?.n ?? 0 };
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

    return {
      id: conv.id,
      subject: conv.subject,
      projectId: conv.projectId,
      isNoise: conv.isNoise,
      archived: conv.archivedAt != null,
      summary: conv.summary,
      messages: msgs.map(
        (m): MessageDto => ({
          id: m.id,
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
          outgoingStatus: m.outgoingStatus,
          attachments: atts
            .filter((a) => a.messageId === m.id)
            .map(
              (a): AttachmentDto => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, isInline: a.isInline }),
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
