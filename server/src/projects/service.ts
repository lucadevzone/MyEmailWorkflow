import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ProjectDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { accounts, conversations, messages, projects } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';

export const projectInputSchema = z.object({
  name: z.string().trim().min(1, 'Il nome è obbligatorio'),
  description: z.string().trim().nullable().optional(),
  outgoingAccountId: z.string().min(1, "Serve un account d'uscita"),
  color: z.string().nullable().optional(),
});

export const projectPatchSchema = projectInputSchema.partial().extend({ archived: z.boolean().optional() });

export class ProjectError extends Error {}

export class ProjectService {
  constructor(private db: Db) {}

  list(): ProjectDto[] {
    const rows = this.db
      .select()
      .from(projects)
      .where(isNull(projects.deletedAt))
      .orderBy(asc(projects.archived), asc(projects.name))
      .all();

    const stats = this.db
      .select({
        projectId: conversations.projectId,
        conversations: sql<number>`count(distinct ${conversations.id})`,
        lastMessageAt: sql<number | null>`max(${conversations.lastMessageAt})`,
      })
      .from(conversations)
      .where(and(isNull(conversations.deletedAt), isNull(conversations.trashedAt), isNull(conversations.archivedAt)))
      .groupBy(conversations.projectId)
      .all();
    const unread = this.db
      .select({ projectId: conversations.projectId, n: sql<number>`count(${messages.id})` })
      .from(conversations)
      .innerJoin(messages, eq(messages.conversationId, conversations.id))
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
      .groupBy(conversations.projectId)
      .all();
    const statsBy = new Map(stats.map((s) => [s.projectId, s]));
    const unreadBy = new Map(unread.map((u) => [u.projectId, u.n]));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      outgoingAccountId: r.outgoingAccountId,
      color: r.color,
      archived: r.archived,
      conversationCount: statsBy.get(r.id)?.conversations ?? 0,
      unreadCount: unreadBy.get(r.id) ?? 0,
      lastMessageAt: statsBy.get(r.id)?.lastMessageAt ?? null,
    }));
  }

  get(id: string): ProjectDto | undefined {
    return this.list().find((p) => p.id === id);
  }

  create(input: z.infer<typeof projectInputSchema>): ProjectDto {
    this.assertAccount(input.outgoingAccountId);
    const t = now();
    const id = newId();
    this.db
      .insert(projects)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        outgoingAccountId: input.outgoingAccountId,
        color: input.color ?? null,
        createdAt: t,
        updatedAt: t,
      })
      .run();
    return this.get(id)!;
  }

  update(id: string, patch: z.infer<typeof projectPatchSchema>): ProjectDto | undefined {
    if (patch.outgoingAccountId) this.assertAccount(patch.outgoingAccountId);
    const res = this.db
      .update(projects)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
      .run();
    return res.changes ? this.get(id) : undefined;
  }

  private assertAccount(accountId: string) {
    const acc = this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .get();
    if (!acc) throw new ProjectError('Account di uscita inesistente');
  }
}
