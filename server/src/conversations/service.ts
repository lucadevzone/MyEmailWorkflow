import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type {
  AttachmentDto,
  ConversationDetail,
  ConversationListItem,
  ConversationView,
  MessageDto,
  PersonRef,
} from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { accounts, attachments, contactAddresses, conversations, messageAddresses, messages } from '../db/schema.ts';
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

  list(view: ConversationView, opts: { limit?: number; before?: number } = {}): ConversationListItem[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const where = [
      isNull(conversations.deletedAt),
      isNull(conversations.projectId),
      eq(conversations.isNoise, view === 'noise'),
    ];
    if (opts.before) where.push(lt(conversations.lastMessageAt, opts.before));

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
        participants: peopleById.get(r.id) ?? [],
        accountIds: s?.accountIds ? s.accountIds.split(',') : [],
      };
    });
  }

  counts(): { inbox: number; noise: number; inboxUnread: number } {
    const row = this.db
      .select({
        inbox: sql<number>`sum(case when ${conversations.isNoise} = 0 then 1 else 0 end)`,
        noise: sql<number>`sum(case when ${conversations.isNoise} = 1 then 1 else 0 end)`,
      })
      .from(conversations)
      .where(and(isNull(conversations.deletedAt), isNull(conversations.projectId)))
      .get();
    const unread = this.db
      .select({ n: sql<number>`count(distinct ${conversations.id})` })
      .from(conversations)
      .innerJoin(messages, eq(messages.conversationId, conversations.id))
      .where(
        and(
          isNull(conversations.deletedAt),
          isNull(conversations.projectId),
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
          attachments: atts
            .filter((a) => a.messageId === m.id)
            .map(
              (a): AttachmentDto => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, isInline: a.isInline }),
            ),
        }),
      ),
    };
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
