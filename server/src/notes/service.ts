// Note personali e risorse (file caricati) di conversazioni e progetti.

import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { NoteDto, ResourceDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { blobs, conversations, notes, resources } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import type { BlobStore } from '../store/blobs.ts';

export const noteInputSchema = z
  .object({
    conversationId: z.string().optional(),
    projectId: z.string().optional(),
    body: z.string().trim().min(1, 'La nota è vuota'),
  })
  .refine((n) => n.conversationId || n.projectId, { message: 'Serve una conversazione o un progetto' });

export class NotesError extends Error {}

type NoteRow = typeof notes.$inferSelect;
type ResourceRow = typeof resources.$inferSelect;

const noteDto = (n: NoteRow): NoteDto => ({
  id: n.id,
  conversationId: n.conversationId,
  projectId: n.projectId,
  body: n.body,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

export class NotesService {
  constructor(private db: Db, private blobStore: BlobStore) {}

  /** Il progetto di una nota o risorsa di conversazione è quello della conversazione. */
  private projectOf(conversationId: string | undefined, projectId: string | undefined): string | null {
    if (!conversationId) return projectId ?? null;
    const c = this.db.select({ p: conversations.projectId }).from(conversations).where(eq(conversations.id, conversationId)).get();
    if (!c) throw new NotesError('Conversazione non trovata');
    return c.p;
  }

  notesFor(conversationId: string): NoteDto[] {
    return this.db
      .select()
      .from(notes)
      .where(and(eq(notes.conversationId, conversationId), isNull(notes.deletedAt)))
      .orderBy(desc(notes.updatedAt))
      .all()
      .map(noteDto);
  }

  createNote(input: z.infer<typeof noteInputSchema>): NoteDto {
    const t = now();
    const row: NoteRow = {
      id: newId(),
      conversationId: input.conversationId ?? null,
      projectId: this.projectOf(input.conversationId, input.projectId),
      annotationId: null,
      body: input.body,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
    };
    this.db.insert(notes).values(row).run();
    return noteDto(row);
  }

  updateNote(id: string, body: string): NoteDto {
    if (!body.trim()) throw new NotesError('La nota è vuota');
    const res = this.db.update(notes).set({ body, updatedAt: now() }).where(and(eq(notes.id, id), isNull(notes.deletedAt))).run();
    if (!res.changes) throw new NotesError('Nota non trovata');
    return noteDto(this.db.select().from(notes).where(eq(notes.id, id)).get()!);
  }

  deleteNote(id: string): string | null {
    const n = this.db.select().from(notes).where(eq(notes.id, id)).get();
    this.db.update(notes).set({ deletedAt: now(), updatedAt: now() }).where(eq(notes.id, id)).run();
    return n?.conversationId ?? null;
  }

  resourcesFor(conversationId: string): ResourceDto[] {
    const rows = this.db
      .select({ r: resources, size: blobs.size, mime: blobs.mime })
      .from(resources)
      .leftJoin(blobs, eq(blobs.sha256, resources.blobSha))
      .where(and(eq(resources.conversationId, conversationId), isNull(resources.deletedAt)))
      .orderBy(desc(resources.createdAt))
      .all();
    return rows.map(({ r, size, mime }) => resourceDto(r, size, mime));
  }

  /** File del progetto: risorse sue e delle sue conversazioni (per allegarli a una bozza). */
  resourcesForProject(projectId: string): ResourceDto[] {
    const rows = this.db
      .select({ r: resources, size: blobs.size, mime: blobs.mime })
      .from(resources)
      .leftJoin(blobs, eq(blobs.sha256, resources.blobSha))
      .leftJoin(conversations, eq(conversations.id, resources.conversationId))
      .where(
        and(
          or(eq(resources.projectId, projectId), eq(conversations.projectId, projectId)),
          eq(resources.kind, 'file'),
          isNull(resources.deletedAt),
        ),
      )
      .orderBy(desc(resources.createdAt))
      .all();
    return rows.map(({ r, size, mime }) => resourceDto(r, size, mime));
  }

  addFile(target: { conversationId?: string; projectId?: string }, filename: string, data: Buffer, mime: string | null): ResourceDto {
    if (!data.length) throw new NotesError('File vuoto');
    const sha = this.blobStore.put(data, mime);
    const t = now();
    const row: ResourceRow = {
      id: newId(),
      projectId: this.projectOf(target.conversationId, target.projectId),
      conversationId: target.conversationId ?? null,
      kind: 'file',
      blobSha: sha,
      url: null,
      title: filename,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
    };
    this.db.insert(resources).values(row).run();
    return resourceDto(row, data.length, mime);
  }

  /** Copia un allegato tra le risorse della conversazione (stesso blob: nessuna duplicazione su disco). */
  addFromBlob(conversationId: string, title: string, blobSha: string): ResourceDto {
    const blob = this.db.select().from(blobs).where(eq(blobs.sha256, blobSha)).get();
    if (!blob) throw new NotesError('File non trovato');
    const t = now();
    const row: ResourceRow = {
      id: newId(),
      projectId: this.projectOf(conversationId, undefined),
      conversationId,
      kind: 'file',
      blobSha,
      url: null,
      title,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
    };
    this.db.insert(resources).values(row).run();
    return resourceDto(row, blob.size, blob.mime);
  }

  getResource(id: string): ResourceRow | undefined {
    return this.db.select().from(resources).where(and(eq(resources.id, id), isNull(resources.deletedAt))).get();
  }

  deleteResource(id: string): string | null {
    const r = this.getResource(id);
    this.db.update(resources).set({ deletedAt: now(), updatedAt: now() }).where(eq(resources.id, id)).run();
    return r?.conversationId ?? null;
  }
}

function resourceDto(r: ResourceRow, size: number | null, mime: string | null): ResourceDto {
  return {
    id: r.id,
    conversationId: r.conversationId,
    projectId: r.projectId,
    kind: r.kind,
    title: r.title,
    url: r.url,
    size,
    mime,
    createdAt: r.createdAt,
  };
}
