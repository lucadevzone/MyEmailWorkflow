// Sintesi delle conversazioni: una riga + una versione di 4-5 righe, aggiornate a ogni nuovo messaggio.

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { conversations, messages } from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { ollamaJson } from './ollama-chat.ts';
import { enqueueJob, PRIORITY } from '../jobs/queue.ts';
import { conversationInWindow, inWindowSql } from './window.ts';

const MAX_MESSAGES = 10;
const MAX_CHARS_PER_MESSAGE = 1500;

const SYSTEM =
  'Sei un assistente che sintetizza conversazioni email per il loro destinatario. ' +
  'Scrivi in italiano, in modo asciutto e concreto. Rispondi solo con un oggetto JSON.';

export type Summarizer = (input: string) => Promise<{ breve?: string; dettagliata?: string }>;

export const ollamaSummarizer: Summarizer = (input) => ollamaJson(SYSTEM, input);

export function enqueueSummary(db: Db, conversationId: string, priority: number = PRIORITY.normal) {
  // Fuori dalla finestra dell'analisi la sintesi si genera solo su richiesta.
  if (!conversationInWindow(db, conversationId)) return;
  enqueueJob(db, 'summarize', { conversationId }, priority);
}

/** Accoda le sintesi mancanti (conversazioni non rumore), più recenti prima. */
export function enqueueMissingSummaries(db: Db) {
  const rows = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(isNull(conversations.deletedAt), isNull(conversations.summary), eq(conversations.isNoise, false), inWindowSql(db)))
    .orderBy(desc(conversations.lastMessageAt))
    .all();
  for (const r of rows) enqueueSummary(db, r.id, PRIORITY.background);
}

export function buildSummaryPrompt(db: Db, conversationId: string): string | null {
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv || conv.deletedAt) return null;
  const msgs = db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.date))
    .all()
    .slice(-MAX_MESSAGES);
  if (!msgs.length) return null;

  const lines = msgs.map((m) => {
    const who = m.direction === 'out' ? 'Io' : m.fromName || m.fromAddress || 'Sconosciuto';
    const when = new Date(m.date).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
    const text = (m.bodyTextClean || m.bodyText || '').slice(0, MAX_CHARS_PER_MESSAGE);
    return `[${when}] ${who}:\n${text}`;
  });

  return [
    `Oggetto: ${conv.subject ?? '(nessuno)'}`,
    '',
    'Messaggi, dal più vecchio al più recente ("Io" è il destinatario della sintesi):',
    '',
    lines.join('\n\n---\n\n'),
    '',
    'Produci un JSON con due campi:',
    '- "breve": una sola frase (massimo 15 parole) che dica di cosa si tratta e a che punto è;',
    '- "dettagliata": da 3 a 5 frasi con i punti chiave, le richieste ancora aperte e chi deve fare cosa.',
  ].join('\n');
}

export async function summarizeConversation(db: Db, conversationId: string, summarizer: Summarizer = ollamaSummarizer) {
  const prompt = buildSummaryPrompt(db, conversationId);
  if (!prompt) return;
  const out = await summarizer(prompt);
  const breve = out.breve?.trim();
  if (!breve) throw new Error('Sintesi vuota');
  db.update(conversations)
    .set({ summary: breve, summaryDetailed: out.dettagliata?.trim() || null, summaryUpdatedAt: now() })
    .where(eq(conversations.id, conversationId))
    .run();
  bus.publish({ type: 'conversations', ids: [conversationId] });
}
