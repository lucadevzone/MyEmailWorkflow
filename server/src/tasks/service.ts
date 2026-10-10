// Task: stanno nei progetti, in una coda ordinata a mano (indici frazionari).
// Un task nuovo va in fondo; "in cima" lo mette in testa (la priorità del requisito RF-F1).

import { and, asc, desc, eq, isNull, like } from 'drizzle-orm';
import { z } from 'zod';
import { createAnnotation, quoteSchema } from '../annotations/service.ts';
import type { TaskDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { conversations, messages, projects, tasks } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { rankBetween } from '../lib/rank.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (AAAA-MM-GG)');

export const taskInputSchema = z.object({
  projectId: z.string().min(1, 'I task stanno in un progetto'),
  title: z.string().trim().min(1, 'Il titolo è obbligatorio').max(300),
  details: z.string().trim().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  top: z.boolean().optional(),
  /** Brano del messaggio da cui nasce il task (annotazione). */
  quote: quoteSchema.optional(),
});

export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    details: z.string().trim().nullable(),
    dueDate: isoDate.nullable(),
    status: z.enum(['open', 'done']),
    projectId: z.string().min(1),
  })
  .partial();

export const taskMoveSchema = z.object({
  /** Il task va subito dopo questo (null = in cima). */
  afterId: z.string().nullable(),
});

export class TaskError extends Error {}

type Row = typeof tasks.$inferSelect;

export class TaskService {
  constructor(private db: Db) {}

  private toDto(r: Row, subject: string | null): TaskDto {
    return {
      id: r.id,
      projectId: r.projectId,
      conversationId: r.conversationId,
      messageId: r.messageId,
      conversationSubject: subject,
      title: r.title,
      details: r.details,
      status: r.status,
      rank: r.rank,
      priority: r.priority,
      dueDate: r.dueDate,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
    };
  }

  private query(where: ReturnType<typeof and>) {
    return this.db
      .select({ t: tasks, subject: conversations.subject })
      .from(tasks)
      .leftJoin(conversations, eq(conversations.id, tasks.conversationId))
      .where(where);
  }

  /** Aperti in ordine di coda; completati dal più recente. */
  forProject(projectId: string): TaskDto[] {
    const open = this.query(and(eq(tasks.projectId, projectId), eq(tasks.status, 'open'), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.rank))
      .all();
    const done = this.query(and(eq(tasks.projectId, projectId), eq(tasks.status, 'done'), isNull(tasks.deletedAt)))
      .orderBy(desc(tasks.completedAt))
      .limit(100)
      .all();
    return [...open, ...done].map(({ t, subject }) => this.toDto(t, subject));
  }

  forConversation(conversationId: string): TaskDto[] {
    return this.query(and(eq(tasks.conversationId, conversationId), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.status), asc(tasks.rank))
      .all()
      .map(({ t, subject }) => this.toDto(t, subject));
  }

  get(id: string): TaskDto | undefined {
    const r = this.query(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
    return r && this.toDto(r.t, r.subject);
  }

  private edgeRank(projectId: string, edge: 'first' | 'last'): string | null {
    return (
      this.db
        .select({ rank: tasks.rank })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), eq(tasks.status, 'open'), isNull(tasks.deletedAt)))
        .orderBy(edge === 'first' ? asc(tasks.rank) : desc(tasks.rank))
        .get()?.rank ?? null
    );
  }

  create(input: z.infer<typeof taskInputSchema>): TaskDto {
    const p = this.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt))).get();
    if (!p) throw new TaskError('Progetto non trovato');
    const rank = input.top ? rankBetween(null, this.edgeRank(input.projectId, 'first')) : rankBetween(this.edgeRank(input.projectId, 'last'), null);
    const t = now();
    const id = newId();
    this.db
      .insert(tasks)
      .values({
        id,
        projectId: input.projectId,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        title: input.title,
        details: input.details ?? null,
        status: 'open',
        rank,
        priority: input.top ? 1 : null,
        dueDate: input.dueDate ?? null,
        annotationId: input.quote && input.messageId ? createAnnotation(this.db, input.messageId, input.quote) : null,
        createdAt: t,
        updatedAt: t,
      })
      .run();
    return this.get(id)!;
  }

  update(id: string, patch: z.infer<typeof taskPatchSchema>): TaskDto {
    const cur = this.db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
    if (!cur) throw new TaskError('Task non trovato');
    const t = now();
    const extra: Partial<Row> = {};
    if (patch.status && patch.status !== cur.status) {
      extra.completedAt = patch.status === 'done' ? t : null;
      // Riaperto: torna in fondo alla coda.
      if (patch.status === 'open') extra.rank = rankBetween(this.edgeRank(patch.projectId ?? cur.projectId!, 'last'), null);
    }
    if (patch.projectId && patch.projectId !== cur.projectId && !extra.rank) {
      extra.rank = rankBetween(this.edgeRank(patch.projectId, 'last'), null);
    }
    this.db.update(tasks).set({ ...patch, ...extra, updatedAt: t }).where(eq(tasks.id, id)).run();
    return this.get(id)!;
  }

  /** Sposta un task aperto subito dopo afterId (null = in cima). */
  move(id: string, afterId: string | null): TaskDto {
    const cur = this.db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
    if (!cur?.projectId) throw new TaskError('Task non trovato');
    const open = this.db
      .select({ id: tasks.id, rank: tasks.rank })
      .from(tasks)
      .where(and(eq(tasks.projectId, cur.projectId), eq(tasks.status, 'open'), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.rank))
      .all()
      .filter((x) => x.id !== id);
    const i = afterId ? open.findIndex((x) => x.id === afterId) : -1;
    if (afterId && i < 0) throw new TaskError('Posizione non valida');
    const rank = rankBetween(open[i]?.rank ?? null, open[i + 1]?.rank ?? null);
    this.db.update(tasks).set({ rank, priority: null, updatedAt: now() }).where(eq(tasks.id, id)).run();
    return this.get(id)!;
  }

  /**
   * Il task di default "Rispondere a <mittente> — <oggetto>", legato al messaggio ricevuto indicato (o
   * all'ultimo ricevuto). Uno solo aperto per conversazione; si chiude da solo quando si risponde.
   */
  remindReply(conversationId: string, messageId?: string | null): TaskDto {
    const conv = this.db.select().from(conversations).where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt))).get();
    if (!conv) throw new TaskError('Conversazione non trovata');
    if (!conv.projectId) throw new TaskError('Sposta prima la conversazione in un progetto');
    const open = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.conversationId, conversationId), eq(tasks.status, 'open'), isNull(tasks.deletedAt), like(tasks.title, 'Rispondere a %')))
      .get();
    if (open) return this.get(open.id)!;
    const m = this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
          messageId ? eq(messages.id, messageId) : eq(messages.direction, 'in'),
        ),
      )
      .orderBy(desc(messages.date))
      .get();
    const who = m?.fromName || m?.fromAddress || 'mittente';
    const title = `Rispondere a ${who}${conv.subject ? ` — ${conv.subject}` : ''}`.slice(0, 300);
    return this.create({ projectId: conv.projectId, conversationId, messageId: m?.id ?? null, title });
  }

  remove(id: string) {
    this.db.update(tasks).set({ deletedAt: now(), updatedAt: now() }).where(eq(tasks.id, id)).run();
  }
}
