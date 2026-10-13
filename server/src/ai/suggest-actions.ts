// Azioni rapide suggerite per una email in arrivo recente: una sola valutazione dell'LLM, al massimo
// un'azione tra "rispondi" (con bozza), "archivia" (non chiede nulla) ed "è rumore" (automatica, solo in Da smistare).

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { conversations, messages, suggestions } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { config } from '../config.ts';
import { enqueueJob, PRIORITY } from '../jobs/queue.ts';
import type { Llm } from './classify.ts';
import { projectContext, type BlobReader } from './project-context.ts';
import { messageInWindow } from './window.ts';

export type QuickAction = 'reply' | 'archive' | 'noise';

export interface ActionSuggestionPayload {
  action: QuickAction;
  messageId: string;
  /** Solo per "reply": testo proposto, da rivedere nel compositore. */
  draft?: string;
  reason?: string;
}

const SYSTEM =
  "Aiuti l'utente a gestire la posta: per un messaggio ricevuto valuti se richiede una risposta e, se sì, " +
  'scrivi una bozza breve e cordiale in italiano, in prima persona, senza firma e senza inventare fatti. Rispondi solo con un oggetto JSON.';

export function enqueueActionSuggestion(db: Db, messageId: string, priority: number = PRIORITY.normal) {
  if (!messageInWindow(db, messageId)) return;
  enqueueJob(db, 'suggest_actions', { messageId }, priority);
}

export function clearActionSuggestions(db: Db, conversationId: string, only?: QuickAction[]): number {
  const rows = db
    .select({ id: suggestions.id, payload: suggestions.payload })
    .from(suggestions)
    .where(and(eq(suggestions.subjectId, conversationId), eq(suggestions.kind, 'action'), eq(suggestions.status, 'pending')))
    .all()
    .filter((r) => !only || only.includes((JSON.parse(r.payload) as ActionSuggestionPayload).action));
  if (rows.length) db.delete(suggestions).where(inArray(suggestions.id, rows.map((r) => r.id))).run();
  return rows.length;
}

export async function suggestActions(db: Db, messageId: string, llm: Llm, readBlob?: BlobReader) {
  const m = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!m || m.deletedAt || m.direction !== 'in') return;
  const conv = db.select().from(conversations).where(eq(conversations.id, m.conversationId)).get();
  if (!conv || conv.deletedAt || conv.isNoise || conv.archivedAt || conv.trashedAt) return;
  // Se nel frattempo ho già risposto, non serve suggerire nulla.
  const later = db
    .select({ id: messages.id, direction: messages.direction, date: messages.date })
    .from(messages)
    .where(and(eq(messages.conversationId, m.conversationId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.date))
    .all()
    .filter((x) => x.date > m.date);
  if (later.some((x) => x.direction === 'out')) return;
  const text = (m.bodyTextClean || m.bodyText || '').slice(0, 2500);
  if (!text.trim()) return;

  const prompt = [
    `Da: ${m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}`,
    `Oggetto: ${m.subject ?? ''}`,
    conv.summary ? `Contesto della conversazione: ${conv.summaryDetailed ?? conv.summary}` : '',
    readBlob && conv.projectId ? `\nContesto del progetto (note e materiali dell'utente, da usare se pertinenti):\n${projectContext(db, conv.projectId, readBlob).slice(0, 5000)}\n` : '',
    '',
    text,
    '',
    'Rispondi con un JSON:',
    '- "tipo": "personale" se scritto da una persona, "automatica" se è una notifica, una newsletter o un messaggio generato da un sistema;',
    '- "azione": "rispondere" se il mittente si aspetta una risposta, "archiviare" se non chiede nulla (ringraziamenti, conferme, informative), altrimenti "nessuna";',
    '- "bozza": solo se "rispondere", una risposta di 1-3 frasi che prende atto, conferma o chiede chiarimenti.',
    '  Non affermare di aver già fatto qualcosa, di allegare file o di sapere cose non scritte nel messaggio;',
    '  dove serve un\'informazione che non conosci lascia un segnaposto tra parentesi quadre, es. [orario];',
    '- "motivo": una frase breve per l\'utente.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const out = await llm<{ tipo?: string; azione?: string; bozza?: string; motivo?: string }>(SYSTEM, prompt);
  let payload: ActionSuggestionPayload | null = null;
  if (out.tipo === 'automatica' && !conv.projectId) payload = { action: 'noise', messageId, reason: out.motivo };
  else if (out.azione === 'rispondere' && out.bozza?.trim()) payload = { action: 'reply', messageId, draft: out.bozza.trim().slice(0, 2000), reason: out.motivo };
  else if (out.azione === 'archiviare') payload = { action: 'archive', messageId, reason: out.motivo };

  clearActionSuggestions(db, m.conversationId);
  if (payload) {
    db.insert(suggestions)
      .values({
        id: newId(),
        kind: 'action',
        subjectType: 'conversation',
        subjectId: m.conversationId,
        payload: JSON.stringify(payload),
        confidence: null,
        status: 'pending',
        model: config.ollama.llmModel,
        createdAt: now(),
      })
      .run();
  }
  bus.publish({ type: 'conversations', ids: [m.conversationId] });
}
