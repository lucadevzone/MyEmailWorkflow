// Bozze salvate (S3): risposte, inoltri e nuove mail in scrittura, con salvataggio
// automatico. All'invio la bozza diventa un messaggio in coda e viene eliminata.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DraftAttachment, DraftDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { drafts, resources } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import type { BlobStore } from '../store/blobs.ts';
import { ActionError, type MailActions } from '../actions/mail-actions.ts';
import type { AssistantService } from '../ai/assistant.ts';

const emails = z.array(z.string().trim().min(1)).max(200);

export const draftCreateSchema = z.object({
  projectId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  replyToMessageId: z.string().nullable().optional(),
  forwardMessageId: z.string().nullable().optional(),
  to: emails.optional(),
  cc: emails.optional(),
  bcc: emails.optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(1_000_000).optional(),
  includeQuote: z.boolean().optional(),
});

export const draftPatchSchema = z.object({
  projectId: z.string().nullable().optional(),
  to: emails.optional(),
  cc: emails.optional(),
  bcc: emails.optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(1_000_000).optional(),
  includeQuote: z.boolean().optional(),
});

type Row = typeof drafts.$inferSelect;

const toDto = (r: Row): DraftDto => ({
  id: r.id,
  projectId: r.projectId,
  conversationId: r.conversationId,
  replyToMessageId: r.replyToMessageId,
  forwardMessageId: r.forwardMessageId,
  to: JSON.parse(r.to) as string[],
  cc: JSON.parse(r.cc) as string[],
  bcc: JSON.parse(r.bcc) as string[],
  subject: r.subject,
  body: r.body,
  includeQuote: r.includeQuote,
  attachments: JSON.parse(r.attachments) as DraftAttachment[],
  updatedAt: r.updatedAt,
});

export class DraftService {
  constructor(private deps: { db: Db; blobs: BlobStore; actions: MailActions; assistant?: AssistantService }) {}

  private row(id: string): Row {
    const r = this.deps.db.select().from(drafts).where(eq(drafts.id, id)).get();
    if (!r) throw new ActionError('Bozza non trovata');
    return r;
  }

  get(id: string): DraftDto {
    return toDto(this.row(id));
  }

  byConversation(conversationId: string): DraftDto[] {
    return this.deps.db
      .select()
      .from(drafts)
      .where(eq(drafts.conversationId, conversationId))
      .orderBy(desc(drafts.updatedAt))
      .all()
      .map(toDto);
  }

  create(input: z.infer<typeof draftCreateSchema>): DraftDto {
    const t = now();
    const id = newId();
    this.deps.db
      .insert(drafts)
      .values({
        id,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
        forwardMessageId: input.forwardMessageId ?? null,
        to: JSON.stringify(input.to ?? []),
        cc: JSON.stringify(input.cc ?? []),
        bcc: JSON.stringify(input.bcc ?? []),
        subject: input.subject ?? '',
        body: input.body ?? '',
        includeQuote: input.includeQuote ?? false,
        createdAt: t,
        updatedAt: t,
      })
      .run();
    return this.get(id);
  }

  update(id: string, patch: z.infer<typeof draftPatchSchema>): DraftDto {
    this.row(id);
    const set: Partial<Row> = { updatedAt: now() };
    if (patch.projectId !== undefined) set.projectId = patch.projectId;
    if (patch.to) set.to = JSON.stringify(patch.to);
    if (patch.cc) set.cc = JSON.stringify(patch.cc);
    if (patch.bcc) set.bcc = JSON.stringify(patch.bcc);
    if (patch.subject !== undefined) set.subject = patch.subject;
    if (patch.body !== undefined) set.body = patch.body;
    if (patch.includeQuote !== undefined) set.includeQuote = patch.includeQuote;
    this.deps.db.update(drafts).set(set).where(eq(drafts.id, id)).run();
    return this.get(id);
  }

  /** Restituisce la conversazione della bozza eliminata (per aggiornare l'indicatore). */
  remove(id: string): string | null {
    const r = this.row(id);
    this.deps.db.delete(drafts).where(eq(drafts.id, id)).run();
    this.deps.assistant?.clear(`draft:${id}`);
    return r.conversationId;
  }

  private setAttachments(id: string, list: DraftAttachment[]): DraftDto {
    this.deps.db.update(drafts).set({ attachments: JSON.stringify(list), updatedAt: now() }).where(eq(drafts.id, id)).run();
    return this.get(id);
  }

  addFile(id: string, filename: string, data: Buffer, mime: string | null): DraftDto {
    const d = this.get(id);
    if (!data.length) throw new ActionError('File vuoto');
    const blobSha = this.deps.blobs.put(data, mime);
    return this.setAttachments(id, [...d.attachments, { id: newId(), blobSha, filename, mime, size: data.length }]);
  }

  /** "Da risorse del progetto": si allega il file di una risorsa esistente. */
  addResource(id: string, resourceId: string): DraftDto {
    const d = this.get(id);
    const r = this.deps.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, resourceId), isNull(resources.deletedAt)))
      .get();
    if (!r?.blobSha) throw new ActionError('Risorsa non trovata o senza file');
    const size = this.deps.blobs.read(r.blobSha).length;
    return this.setAttachments(id, [...d.attachments, { id: newId(), blobSha: r.blobSha, filename: r.title, mime: null, size }]);
  }

  removeAttachment(id: string, attachmentId: string): DraftDto {
    const d = this.get(id);
    return this.setAttachments(id, d.attachments.filter((a) => a.id !== attachmentId));
  }

  send(id: string, urgent: boolean) {
    const d = this.get(id);
    if (!d.projectId) throw new ActionError('Scegli il progetto da cui scrivere');
    const res = this.deps.actions.compose({
      projectId: d.projectId,
      replyToMessageId: d.replyToMessageId ?? undefined,
      forwardMessageId: d.forwardMessageId ?? undefined,
      includeQuote: d.includeQuote,
      attachments: d.attachments.map((a) => ({ blobSha: a.blobSha, filename: a.filename, mime: a.mime })),
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body: d.body,
      urgent,
    });
    this.deps.db.delete(drafts).where(eq(drafts.id, id)).run();
    this.deps.assistant?.moveThread(`draft:${id}`, res.conversationId);
    return { ...res, previousConversationId: d.conversationId };
  }
}
