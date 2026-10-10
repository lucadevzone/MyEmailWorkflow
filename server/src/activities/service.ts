// Coda attività: operazioni con effetti sul server di posta, visibili e annullabili.
// Vedi docs/02-system-design.md §6.4.
//
// L'effetto locale è immediato (la conversazione sparisce, il messaggio compare "in coda"...);
// l'effetto sul server avviene quando l'attività viene eseguita. Annullare un'attività
// ancora in attesa ripristina lo stato locale.

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ActivityDto, ActivityKind } from '@mmw/shared';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import { activities, conversations, messages } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { ConversationService } from '../conversations/service.ts';

export interface FlagsPayload {
  label: string;
  /** Vuoto per le operazioni su più conversazioni ("segna tutto come letto"). */
  conversationId: string;
  messageIds: string[];
  add?: string[];
  remove?: string[];
}

export interface ConversationOpPayload {
  label: string;
  conversationId: string;
}

export interface SendPayload {
  label: string;
  conversationId: string;
  messageId: string;
  /** La conversazione è stata creata per questo invio: se si annulla, sparisce anche lei. */
  createdConversation: boolean;
  fromName: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  attachments?: { blobSha: string; filename: string; mime: string | null }[];
  /** Quanto serve per rimettere l'invio in bozza ("Blocca invio") senza perdere nulla. */
  draft?: SendDraftSnapshot;
}

export interface SendDraftSnapshot {
  projectId: string;
  replyToMessageId: string | null;
  forwardMessageId: string | null;
  includeQuote: boolean;
  /** Testo scritto dall'utente, senza citazione o inoltro aggiunti all'invio. */
  body: string;
  /** Solo gli allegati aggiunti dall'utente (quelli dell'inoltro tornano da soli). */
  attachments: { blobSha: string; filename: string; mime: string | null }[];
}

export type ActivityPayload = FlagsPayload | ConversationOpPayload | SendPayload;
type ActivityRow = typeof activities.$inferSelect;

export class ActivityError extends Error {}

export class ActivityService {
  private conversations: ConversationService;

  constructor(private db: Db, private sqlite: Database.Database) {
    this.conversations = new ConversationService(db);
  }

  enqueue(kind: ActivityKind, accountId: string, payload: ActivityPayload, urgent = false): ActivityRow {
    const t = now();
    const row: ActivityRow = {
      id: newId(),
      kind,
      accountId,
      payload: JSON.stringify(payload),
      status: 'pending',
      urgent,
      attempts: 0,
      lastError: null,
      createdAt: t,
      updatedAt: t,
      executedAt: null,
    };
    this.db.insert(activities).values(row).run();
    bus.publish({ type: 'activities' });
    return row;
  }

  get(id: string): ActivityRow | undefined {
    return this.db.select().from(activities).where(eq(activities.id, id)).get();
  }

  list(): ActivityDto[] {
    // Tutte quelle aperte + le ultime 50 concluse.
    const open = this.db
      .select()
      .from(activities)
      .where(inArray(activities.status, ['pending', 'running', 'failed']))
      .orderBy(activities.createdAt)
      .all();
    const closed = this.db
      .select()
      .from(activities)
      .where(inArray(activities.status, ['done', 'cancelled']))
      .orderBy(desc(activities.updatedAt))
      .limit(50)
      .all();
    return [...open, ...closed].map(toDto);
  }

  pending(ids?: string[]): ActivityRow[] {
    return this.db
      .select()
      .from(activities)
      .where(and(eq(activities.status, 'pending'), ids ? inArray(activities.id, ids) : undefined))
      .orderBy(activities.createdAt)
      .all();
  }

  pendingCount(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(activities)
        .where(or(eq(activities.status, 'pending'), eq(activities.status, 'failed')))
        .get()?.n ?? 0
    );
  }

  /** Annulla un'attività in attesa (o fallita) e ripristina l'effetto locale. */
  cancel(id: string): ActivityRow {
    const row = this.get(id);
    if (!row) throw new ActivityError('Attività non trovata');
    if (row.status !== 'pending' && row.status !== 'failed') {
      throw new ActivityError(row.status === 'running' ? 'Attività in esecuzione: troppo tardi' : 'Attività già conclusa');
    }
    this.db.transaction(() => {
      this.revertLocal(row);
      this.setStatus(row.id, 'cancelled');
    });
    bus.publish({ type: 'conversations', ids: [conversationOf(row)].filter(Boolean) as string[] });
    return this.get(id)!;
  }

  /** L'invio (in coda o fallito) che riguarda un messaggio in uscita. */
  sendFor(messageId: string): ActivityRow | undefined {
    return this.db
      .select()
      .from(activities)
      .where(and(eq(activities.kind, 'send'), inArray(activities.status, ['pending', 'failed'])))
      .all()
      .find((r) => (JSON.parse(r.payload) as SendPayload).messageId === messageId);
  }

  retry(id: string): void {
    const row = this.get(id);
    if (row?.status !== 'failed') throw new ActivityError('Si possono ritentare solo le attività fallite');
    this.db.update(activities).set({ status: 'pending', updatedAt: now() }).where(eq(activities.id, id)).run();
    if (row.kind === 'send') {
      const p = JSON.parse(row.payload) as SendPayload;
      this.db.update(messages).set({ outgoingStatus: 'queued' }).where(eq(messages.id, p.messageId)).run();
    }
    bus.publish({ type: 'activities' });
  }

  markUrgent(id: string) {
    this.db.update(activities).set({ urgent: true, updatedAt: now() }).where(eq(activities.id, id)).run();
  }

  setStatus(id: string, status: ActivityRow['status'], error: string | null = null) {
    const t = now();
    this.db
      .update(activities)
      .set({
        status,
        lastError: error,
        updatedAt: t,
        ...(status === 'running' ? { attempts: sql`${activities.attempts} + 1` } : {}),
        ...(status === 'done' || status === 'failed' ? { executedAt: t } : {}),
      })
      .where(eq(activities.id, id))
      .run();
    bus.publish({ type: 'activities' });
  }

  /** All'avvio: le attività rimaste "running" (crash) tornano in attesa. */
  recoverInterrupted() {
    this.db.update(activities).set({ status: 'pending', updatedAt: now() }).where(eq(activities.status, 'running')).run();
  }

  private revertLocal(row: ActivityRow) {
    const p = JSON.parse(row.payload) as ActivityPayload;
    switch (row.kind) {
      case 'set_flags': {
        const f = p as FlagsPayload;
        if (f.add?.includes('\\Seen')) this.conversations.setSeen(f.messageIds, false);
        if (f.remove?.includes('\\Seen')) this.conversations.setSeen(f.messageIds, true);
        if (f.add?.includes('\\Flagged')) this.conversations.setImportant(f.messageIds, false);
        if (f.remove?.includes('\\Flagged')) this.conversations.setImportant(f.messageIds, true);
        break;
      }
      case 'archive':
        this.conversations.setArchived((p as ConversationOpPayload).conversationId, false);
        break;
      case 'trash':
        this.conversations.setTrashed((p as ConversationOpPayload).conversationId, false);
        break;
      case 'send': {
        const s = p as SendPayload;
        const t = now();
        this.db.update(messages).set({ deletedAt: t, updatedAt: t }).where(eq(messages.id, s.messageId)).run();
        this.sqlite.prepare('delete from message_fts where message_id = ?').run(s.messageId);
        const left = this.db
          .select({ n: sql<number>`count(*)` })
          .from(messages)
          .where(and(eq(messages.conversationId, s.conversationId), isNull(messages.deletedAt)))
          .get()?.n;
        if (s.createdConversation && !left) {
          this.db.update(conversations).set({ deletedAt: t, updatedAt: t }).where(eq(conversations.id, s.conversationId)).run();
        }
        break;
      }
    }
  }
}

/**
 * Intenzioni di lettura ancora in coda per questi messaggi: il sync non deve sovrascriverle
 * con lo stato del server, che non è ancora stato aggiornato.
 */
export function pendingSeenIntent(db: Db, messageIds: string[]): Map<string, boolean> {
  return pendingFlagIntent(db, messageIds, '\\Seen');
}

/** Come pendingSeenIntent, per un flag qualsiasi (es. \\Flagged = Importante). */
export function pendingFlagIntent(db: Db, messageIds: string[], flag: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!messageIds.length) return out;
  const rows = db
    .select({ payload: activities.payload })
    .from(activities)
    .where(and(eq(activities.kind, 'set_flags'), inArray(activities.status, ['pending', 'running'])))
    .orderBy(activities.createdAt)
    .all();
  const wanted = new Set(messageIds);
  for (const r of rows) {
    const p = JSON.parse(r.payload) as FlagsPayload;
    for (const id of p.messageIds) {
      if (!wanted.has(id)) continue;
      if (p.add?.includes(flag)) out.set(id, true);
      if (p.remove?.includes(flag)) out.set(id, false);
    }
  }
  return out;
}

function conversationOf(row: ActivityRow): string | null {
  try {
    return (JSON.parse(row.payload) as { conversationId?: string }).conversationId ?? null;
  } catch {
    return null;
  }
}

function toDto(row: ActivityRow): ActivityDto {
  const p = JSON.parse(row.payload) as { label?: string };
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.accountId,
    status: row.status,
    urgent: row.urgent,
    label: p.label ?? row.kind,
    conversationId: conversationOf(row),
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    executedAt: row.executedAt,
  };
}
