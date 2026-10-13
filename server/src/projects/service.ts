import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ProjectCategoryDto, ProjectDto, ProjectLayoutInput } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { accounts, conversations, projectCategories, drafts, messages, notes, projectContacts, projectGroups, projects, resources, suggestions, tasks } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { rankBetween } from '../lib/rank.ts';

export const projectInputSchema = z.object({
  name: z.string().trim().min(1, 'Il nome è obbligatorio'),
  description: z.string().trim().nullable().optional(),
  outgoingAccountId: z.string().min(1, "Serve un account d'uscita"),
  signatureId: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
});

export const categoryInputSchema = z.object({ name: z.string().trim().min(1, 'Il nome è obbligatorio') });
export const categoryPatchSchema = categoryInputSchema.partial().extend({ collapsed: z.boolean().optional() });
export const layoutSchema = z.object({
  categories: z.array(z.string()),
  projects: z.array(z.object({ id: z.string(), categoryId: z.string().nullable() })),
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
      // Ordine scelto dall'utente; i progetti mai riordinati vanno in fondo, per nome.
      .orderBy(asc(projects.archived), sql`${projects.rank} is null`, asc(projects.rank), asc(projects.name))
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
    // Task aperti del progetto e quanti sono scaduti (scadenza "AAAA-MM-GG" prima di oggi).
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const taskRows = this.db
      .select({
        projectId: tasks.projectId,
        open: sql<number>`count(*)`,
        overdue: sql<number>`sum(case when ${tasks.dueDate} is not null and ${tasks.dueDate} < ${today} then 1 else 0 end)`,
      })
      .from(tasks)
      .where(and(eq(tasks.status, 'open'), isNull(tasks.deletedAt)))
      .groupBy(tasks.projectId)
      .all();
    const tasksBy = new Map(taskRows.map((t) => [t.projectId, t]));
    const statsBy = new Map(stats.map((s) => [s.projectId, s]));
    const unreadBy = new Map(unread.map((u) => [u.projectId, u.n]));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      outgoingAccountId: r.outgoingAccountId,
      signatureId: r.signatureId,
      color: r.color,
      categoryId: r.categoryId,
      archived: r.archived,
      conversationCount: statsBy.get(r.id)?.conversations ?? 0,
      unreadCount: unreadBy.get(r.id) ?? 0,
      openTaskCount: tasksBy.get(r.id)?.open ?? 0,
      overdueTaskCount: tasksBy.get(r.id)?.overdue ?? 0,
      lastMessageAt: statsBy.get(r.id)?.lastMessageAt ?? null,
    }));
  }

  get(id: string): ProjectDto | undefined {
    return this.list().find((p) => p.id === id);
  }

  create(input: z.infer<typeof projectInputSchema>): ProjectDto {
    this.assertAccount(input.outgoingAccountId);
    if (input.categoryId) this.assertCategory(input.categoryId);
    const t = now();
    const id = newId();
    this.db
      .insert(projects)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        outgoingAccountId: input.outgoingAccountId,
        signatureId: input.signatureId ?? null,
        color: input.color ?? null,
        categoryId: input.categoryId ?? null,
        createdAt: t,
        updatedAt: t,
      })
      .run();
    return this.get(id)!;
  }

  update(id: string, patch: z.infer<typeof projectPatchSchema>): ProjectDto | undefined {
    if (patch.outgoingAccountId) this.assertAccount(patch.outgoingAccountId);
    if (patch.categoryId) this.assertCategory(patch.categoryId);
    const res = this.db
      .update(projects)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
      .run();
    return res.changes ? this.get(id) : undefined;
  }

  /** Nuovo ordine della barra dei progetti (gli id non elencati restano in fondo). */
  reorder(ids: string[]) {
    let prev: string | null = null;
    const t = now();
    this.db.transaction((tx) => {
      for (const id of ids) {
        const rank = rankBetween(prev, null);
        tx.update(projects).set({ rank, updatedAt: t }).where(eq(projects.id, id)).run();
        prev = rank;
      }
    });
  }

  // ─── Categorie ───────────────────────────────────────────────────────────

  categories(): ProjectCategoryDto[] {
    return this.db
      .select({ id: projectCategories.id, name: projectCategories.name, collapsed: projectCategories.collapsed })
      .from(projectCategories)
      .where(isNull(projectCategories.deletedAt))
      .orderBy(sql`${projectCategories.rank} is null`, asc(projectCategories.rank), asc(projectCategories.name))
      .all();
  }

  /** Nuova categoria, in fondo all'elenco. */
  createCategory(input: z.infer<typeof categoryInputSchema>): ProjectCategoryDto {
    const last = this.db
      .select({ rank: projectCategories.rank })
      .from(projectCategories)
      .where(isNull(projectCategories.deletedAt))
      .orderBy(sql`${projectCategories.rank} desc`)
      .limit(1)
      .get();
    const t = now();
    const id = newId();
    this.db.insert(projectCategories).values({ id, name: input.name, rank: rankBetween(last?.rank ?? null, null), createdAt: t, updatedAt: t }).run();
    return this.categories().find((c) => c.id === id)!;
  }

  updateCategory(id: string, patch: z.infer<typeof categoryPatchSchema>): ProjectCategoryDto | undefined {
    const res = this.db
      .update(projectCategories)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(projectCategories.id, id), isNull(projectCategories.deletedAt)))
      .run();
    return res.changes ? this.categories().find((c) => c.id === id) : undefined;
  }

  /** Eliminata la categoria, i suoi progetti finiscono in "Senza categoria". */
  deleteCategory(id: string) {
    const t = now();
    this.db.transaction((tx) => {
      tx.update(projects).set({ categoryId: null, updatedAt: t }).where(eq(projects.categoryId, id)).run();
      tx.update(projectCategories).set({ deletedAt: t, updatedAt: t }).where(eq(projectCategories.id, id)).run();
    });
  }

  /** Disposizione decisa nella modalità Gestione: ordine delle categorie, ordine e categoria dei progetti. */
  saveLayout(layout: ProjectLayoutInput) {
    const known = new Set(this.categories().map((c) => c.id));
    for (const p of layout.projects) if (p.categoryId && !known.has(p.categoryId)) throw new ProjectError('Categoria non trovata');
    const t = now();
    this.db.transaction((tx) => {
      let prev: string | null = null;
      for (const id of layout.categories) {
        if (!known.has(id)) continue;
        const rank = rankBetween(prev, null);
        tx.update(projectCategories).set({ rank, updatedAt: t }).where(eq(projectCategories.id, id)).run();
        prev = rank;
      }
      prev = null;
      for (const p of layout.projects) {
        const rank = rankBetween(prev, null);
        tx.update(projects).set({ rank, categoryId: p.categoryId, updatedAt: t }).where(eq(projects.id, p.id)).run();
        prev = rank;
      }
    });
  }

  private assertCategory(id: string) {
    const c = this.db.select({ id: projectCategories.id }).from(projectCategories).where(and(eq(projectCategories.id, id), isNull(projectCategories.deletedAt))).get();
    if (!c) throw new ProjectError('Categoria non trovata');
  }

  /**
   * Rimuove un progetto dalla barra: le sue conversazioni tornano in Da smistare, mentre note, task e
   * risorse restano legati al progetto, che viene archiviato.
   */
  remove(id: string): { movedConversations: number } {
    const p = this.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))).get();
    if (!p) throw new ProjectError('Progetto non trovato');
    const t = now();
    return this.db.transaction((tx) => {
      const res = tx
        .update(conversations)
        .set({ projectId: null, classifiedAt: null, updatedAt: t })
        .where(and(eq(conversations.projectId, id), isNull(conversations.deletedAt)))
        .run();
      tx.update(projects).set({ archived: true, rank: null, updatedAt: t }).where(eq(projects.id, id)).run();
      return { movedConversations: res.changes };
    });
  }

  /**
   * Fonde il progetto sourceId dentro targetId: conversazioni, task (in coda a quelli del destinatario),
   * note, risorse, bozze, contatti e gruppi passano al destinatario; il sorgente viene eliminato.
   */
  merge(sourceId: string, targetId: string): { movedConversations: number } {
    if (sourceId === targetId) throw new ProjectError('Scegli un progetto diverso');
    const alive = (id: string) =>
      this.db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))).get();
    const src = alive(sourceId);
    const dst = alive(targetId);
    if (!src || !dst) throw new ProjectError('Progetto non trovato');
    const t = now();
    return this.db.transaction((tx) => {
      const moved = tx.update(conversations).set({ projectId: targetId, updatedAt: t }).where(eq(conversations.projectId, sourceId)).run();
      // Task: in coda a quelli del destinatario, nell'ordine che avevano.
      const last = tx
        .select({ rank: tasks.rank })
        .from(tasks)
        .where(and(eq(tasks.projectId, targetId), isNull(tasks.deletedAt)))
        .orderBy(sql`${tasks.rank} desc`)
        .get();
      let prev = last?.rank ?? null;
      const srcTasks = tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, sourceId)).orderBy(asc(tasks.rank)).all();
      for (const row of srcTasks) {
        const rank = rankBetween(prev, null);
        tx.update(tasks).set({ projectId: targetId, rank, updatedAt: t }).where(eq(tasks.id, row.id)).run();
        prev = rank;
      }
      tx.update(notes).set({ projectId: targetId }).where(eq(notes.projectId, sourceId)).run();
      tx.update(resources).set({ projectId: targetId }).where(eq(resources.projectId, sourceId)).run();
      tx.update(drafts).set({ projectId: targetId }).where(eq(drafts.projectId, sourceId)).run();
      // Contatti e gruppi: si aggiungono quelli che il destinatario non ha già.
      tx.run(sql`insert or ignore into project_contacts (project_id, contact_id, rank, created_at)
        select ${targetId}, contact_id, null, created_at from project_contacts where project_id = ${sourceId}`);
      tx.run(sql`insert or ignore into project_groups (project_id, group_id, rank, created_at)
        select ${targetId}, group_id, null, created_at from project_groups where project_id = ${sourceId}`);
      tx.delete(projectContacts).where(eq(projectContacts.projectId, sourceId)).run();
      tx.delete(projectGroups).where(eq(projectGroups.projectId, sourceId)).run();
      // Suggerimenti "sposta nel progetto sorgente" ancora in attesa: non hanno più senso.
      tx.run(sql`delete from ${suggestions} where status = 'pending' and kind = 'project'
        and json_extract(payload, '$.projectId') = ${sourceId}`);
      if (!dst.description && src.description) tx.update(projects).set({ description: src.description, updatedAt: t }).where(eq(projects.id, targetId)).run();
      tx.update(projects).set({ deletedAt: t, rank: null, updatedAt: t }).where(eq(projects.id, sourceId)).run();
      return { movedConversations: moved.changes };
    });
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
