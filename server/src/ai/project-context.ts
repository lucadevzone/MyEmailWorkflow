// Contesto del progetto per l'LLM (RF-C7, RF-E5): descrizione, note (esistono per questo), testo delle
// risorse che si possono leggere come testo, e solo i nomi degli allegati (non il contenuto).

import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { convert } from 'html-to-text';
import type { Db } from '../db/client.ts';
import { attachments, blobs, conversations, messages, notes, projects, resources } from '../db/schema.ts';

export type BlobReader = (sha: string) => Buffer;

const MAX_NOTES_CHARS = 3500;
const MAX_RESOURCE_CHARS = 1500;
const MAX_RESOURCES_CHARS = 4000;
const MAX_ATTACHMENT_NAMES = 40;
const MAX_RESOURCE_BYTES = 512 * 1024;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|ics|log|ini|html?|rtf|tex)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|rtf))/i;

/** Testo di una risorsa, se il file è leggibile come testo (altrimenti null). */
export function resourceText(title: string, mime: string | null, data: Buffer): string | null {
  if (!(TEXT_MIME.test(mime ?? '') || TEXT_EXT.test(title))) return null;
  if (data.length > MAX_RESOURCE_BYTES) data = data.subarray(0, MAX_RESOURCE_BYTES);
  const raw = data.toString('utf8');
  if (raw.includes('\u0000')) return null; // binario travestito
  const text = /\.html?$/i.test(title) || /html/i.test(mime ?? '') ? convert(raw, { wordwrap: false }) : raw;
  return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim() || null;
}

/** Blocco di testo con il contesto del progetto, o '' se il progetto non c'è. */
export function projectContext(db: Db, projectId: string | null | undefined, readBlob: BlobReader): string {
  if (!projectId) return '';
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return '';
  const out: string[] = [`PROGETTO «${project.name}»`];
  if (project.description) out.push(`Descrizione: ${project.description}`);

  // Note del progetto e delle sue conversazioni, dalle più recenti.
  const noteRows = db
    .select({ body: notes.body, subject: conversations.subject })
    .from(notes)
    .leftJoin(conversations, eq(conversations.id, notes.conversationId))
    .where(and(isNull(notes.deletedAt), or(eq(notes.projectId, projectId), eq(conversations.projectId, projectId))))
    .orderBy(desc(notes.updatedAt))
    .all();
  if (noteRows.length) {
    let used = 0;
    const lines: string[] = [];
    for (const n of noteRows) {
      const line = `- ${n.body.replace(/\s+/g, ' ').trim()}${n.subject ? ` (su «${n.subject}»)` : ''}`;
      if (used + line.length > MAX_NOTES_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    out.push('', 'Note:', ...lines);
  }

  // Risorse leggibili come testo.
  const resRows = db
    .select({ title: resources.title, sha: resources.blobSha, mime: blobs.mime })
    .from(resources)
    .leftJoin(blobs, eq(blobs.sha256, resources.blobSha))
    .leftJoin(conversations, eq(conversations.id, resources.conversationId))
    .where(and(isNull(resources.deletedAt), eq(resources.kind, 'file'), or(eq(resources.projectId, projectId), eq(conversations.projectId, projectId))))
    .orderBy(desc(resources.createdAt))
    .all();
  let resUsed = 0;
  const resBlocks: string[] = [];
  const otherRes: string[] = [];
  for (const r of resRows) {
    let text: string | null = null;
    try {
      text = r.sha ? resourceText(r.title, r.mime, readBlob(r.sha)) : null;
    } catch {
      text = null;
    }
    if (text && resUsed < MAX_RESOURCES_CHARS) {
      const chunk = text.slice(0, Math.min(MAX_RESOURCE_CHARS, MAX_RESOURCES_CHARS - resUsed));
      resBlocks.push(`### ${r.title}\n${chunk}${chunk.length < text.length ? '…' : ''}`);
      resUsed += chunk.length;
    } else otherRes.push(r.title);
  }
  if (resBlocks.length) out.push('', 'Risorse (testo):', ...resBlocks);
  if (otherRes.length) out.push('', `Altre risorse (solo nome): ${otherRes.join(', ')}`);

  // Allegati delle conversazioni del progetto: solo i nomi, una volta ciascuno.
  const names = db
    .selectDistinct({ name: attachments.filename })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.projectId, projectId), eq(attachments.isInline, false), isNull(messages.deletedAt)))
    .limit(MAX_ATTACHMENT_NAMES)
    .all()
    .map((a) => a.name)
    .filter((n): n is string => !!n);
  if (names.length) out.push('', `Allegati nel progetto (solo nome): ${names.join(', ')}`);

  return out.length > 1 || project.description ? out.join('\n') : '';
}
