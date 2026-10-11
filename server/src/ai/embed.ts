// Embedding dei messaggi (bge-m3 via Ollama) e ricerca dei vicini con sqlite-vec.
// Si indicizza il testo pulito (senza citazioni né firme), diviso in blocchi; il rumore è escluso.

import { keepAlive } from './ollama-options.ts';
import { and, eq, inArray, isNull, notExists } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { chunks, conversations, messages } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { enqueueJob, PRIORITY } from '../jobs/queue.ts';

const CHUNK_CHARS = 1500;
const MAX_CHUNKS = 4;

export type Embedder = (texts: string[]) => Promise<number[][]>;

export const ollamaEmbedder: Embedder = async (texts) => {
  const res = await fetch(`${config.ollama.url}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    // Anche il modello degli embedding resta caricato: la ricerca non aspetta il caricamento.
    body: JSON.stringify({ model: config.ollama.embedModel, input: texts, keep_alive: keepAlive() }),
  });
  if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
  const body = (await res.json()) as { embeddings?: number[][] };
  if (!body.embeddings || body.embeddings.length !== texts.length) throw new Error('Risposta di embedding inattesa');
  return body.embeddings;
};

/** Blocchi di ~1500 caratteri spezzati su paragrafi; l'oggetto apre il primo blocco come contesto. */
export function chunkText(subject: string | null, body: string): string[] {
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = subject ? `${subject}\n\n` : '';
  for (const p of paragraphs) {
    if (cur.length + p.length > CHUNK_CHARS && cur.trim()) {
      out.push(cur.trim());
      cur = '';
    }
    cur += (p.length > CHUNK_CHARS ? p.slice(0, CHUNK_CHARS) : p) + '\n\n';
    if (out.length >= MAX_CHUNKS) break;
  }
  if (cur.trim() && out.length < MAX_CHUNKS) out.push(cur.trim());
  return out.length ? out : subject ? [subject] : [];
}

export function enqueueEmbedding(db: Db, messageId: string, priority: number = PRIORITY.normal) {
  enqueueJob(db, 'embed', { messageId }, priority);
}

/** Messaggi non rumore ancora senza embedding (più recenti prima). */
export function enqueueMissingEmbeddings(db: Db) {
  const rows = db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        isNull(messages.deletedAt),
        isNull(conversations.deletedAt),
        eq(conversations.isNoise, false),
        notExists(db.select({ x: chunks.id }).from(chunks).where(eq(chunks.messageId, messages.id))),
      ),
    )
    .orderBy(messages.date)
    .all()
    .reverse();
  for (const r of rows) enqueueEmbedding(db, r.id, PRIORITY.background);
}

export async function embedMessage(db: Db, sqlite: Database.Database, messageId: string, embedder: Embedder) {
  const msg = db
    .select({ subject: messages.subject, clean: messages.bodyTextClean, text: messages.bodyText, deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!msg || msg.deletedAt) return;
  const parts = chunkText(msg.subject, msg.clean || msg.text || '');
  if (!parts.length) return;
  const vectors = await embedder(parts);
  if (vectors[0]?.length !== config.embedDim) {
    throw new Error(`Dimensione embedding ${vectors[0]?.length} diversa da ${config.embedDim}: cambiare modello richiede di reindicizzare`);
  }

  const old = db.select({ id: chunks.id }).from(chunks).where(eq(chunks.messageId, messageId)).all().map((c) => c.id);
  const t = now();
  db.transaction((tx) => {
    if (old.length) {
      tx.delete(chunks).where(inArray(chunks.id, old)).run();
      const del = sqlite.prepare('delete from chunk_vec where chunk_id = ?');
      for (const id of old) del.run(id);
    }
    const ins = sqlite.prepare('insert into chunk_vec(chunk_id, embedding) values (?, ?)');
    parts.forEach((text, ord) => {
      const id = newId();
      tx.insert(chunks).values({ id, messageId, ord, text, model: config.ollama.embedModel, createdAt: t }).run();
      ins.run(id, new Float32Array(vectors[ord]!));
    });
  });
}

export interface Neighbor {
  conversationId: string;
  projectId: string | null;
  similarity: number;
}

/**
 * Conversazioni più simili a quella data (media dei suoi vettori), escluse sé stessa e il rumore.
 * Vettori normalizzati: similarità coseno = 1 - d²/2 dalla distanza L2 di sqlite-vec.
 */
export function similarConversations(sqlite: Database.Database, conversationId: string, k = 40): Neighbor[] {
  const own = sqlite
    .prepare(
      `select v.embedding as e from chunk_vec v join chunks c on c.id = v.chunk_id
         join messages m on m.id = c.message_id where m.conversation_id = ? and m.deleted_at is null`,
    )
    .all(conversationId) as { e: Buffer }[];
  if (!own.length) return [];
  const dim = own[0]!.e.byteLength / 4;
  const mean = new Float32Array(dim);
  for (const { e } of own) {
    const v = new Float32Array(e.buffer, e.byteOffset, dim);
    for (let i = 0; i < dim; i++) mean[i]! += v[i]!;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += mean[i]! * mean[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) mean[i]! /= norm;

  const rows = sqlite
    .prepare(
      `with knn as (select chunk_id, distance from chunk_vec where embedding match ? and k = ?)
       select m.conversation_id as conversationId, c2.project_id as projectId, min(knn.distance) as d
         from knn join chunks c on c.id = knn.chunk_id join messages m on m.id = c.message_id
         join conversations c2 on c2.id = m.conversation_id
        where m.conversation_id <> ? and m.deleted_at is null and c2.deleted_at is null and c2.is_noise = 0
        group by m.conversation_id
        order by d`,
    )
    .all(mean, k, conversationId) as { conversationId: string; projectId: string | null; d: number }[];
  return rows.map((r) => ({ conversationId: r.conversationId, projectId: r.projectId, similarity: 1 - (r.d * r.d) / 2 }));
}
