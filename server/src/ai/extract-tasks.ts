// Task suggeriti: richieste e scadenze rivolte all'utente in un messaggio in arrivo (solo posta recente).

import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { conversations, messages, suggestions, tasks } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { config } from '../config.ts';
import { enqueueJob, PRIORITY } from '../jobs/queue.ts';
import type { Llm } from './classify.ts';

const SYSTEM =
  'Individui le richieste esplicite che il mittente di un messaggio email rivolge al destinatario ' +
  '(es. "mandami", "puoi…", "entro venerdì mi serve"). Non inventare passi intermedi e non proporre azioni ' +
  'che nessuno ha chiesto. Spesso non ci sono richieste, o ce n\'è una sola. Scrivi in italiano. Rispondi solo con un oggetto JSON.';

const MAX_TASKS = 2;

/** I calcoli sulle date sono fragili per un LLM: gli si dà un calendario già pronto da consultare. */
/** Il task è dal punto di vista del destinatario: "la tua sezione" → "la mia sezione". */
export function toFirstPerson(title: string): string {
  const map: Record<string, string> = { tuo: 'mio', tua: 'mia', tuoi: 'miei', tue: 'mie' };
  return title.replace(/\b(tuo|tua|tuoi|tue)\b/gi, (w) => {
    const r = map[w.toLowerCase()]!;
    return w[0] === w[0]!.toUpperCase() ? r[0]!.toUpperCase() + r.slice(1) : r;
  });
}

export function calendarFrom(date: Date, days = 14): string {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(`${d.toLocaleDateString('it-IT', { weekday: 'long' })} ${iso}${i === 0 ? ' (giorno del messaggio)' : ''}`);
  }
  return out.join('\n');
}

export interface TaskSuggestionPayload {
  title: string;
  dueDate: string | null;
  details: string | null;
  messageId: string;
}

export function enqueueTaskExtraction(db: Db, messageId: string) {
  enqueueJob(db, 'extract_tasks', { messageId }, PRIORITY.normal);
}

export async function extractTasks(db: Db, messageId: string, llm: Llm) {
  const m = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!m || m.deletedAt || m.direction !== 'in') return;
  const conv = db.select().from(conversations).where(eq(conversations.id, m.conversationId)).get();
  if (!conv || conv.isNoise || conv.deletedAt) return;
  const text = (m.bodyTextClean || m.bodyText || '').slice(0, 3000);
  if (!text.trim()) return;

  const when = new Date(m.date);
  const prompt = [
    `Da: ${m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}`,
    `Oggetto: ${m.subject ?? ''}`,
    '',
    text,
    '',
    'Calendario per risolvere le date relative ("venerdì", "domani", "la prossima settimana"):',
    calendarFrom(when),
    '',
    `Rispondi con un JSON {"task": [...]}, al massimo ${MAX_TASKS} elementi, lista vuota se il mittente non chiede nulla al destinatario.`,
    'Ogni elemento: {"titolo": frase breve all\'infinito dal punto di vista del destinatario, senza "tuo/tua" (es. "Inviare i timesheet di settembre"),',
    '"scadenza": la data "AAAA-MM-GG" presa dal calendario se il messaggio indica una scadenza, altrimenti null,',
    '"dettagli": eventuale precisazione utile, altrimenti null}.',
  ].join('\n');

  const out = await llm<{ task?: { titolo?: string; scadenza?: string | null; dettagli?: string | null }[] }>(SYSTEM, prompt);
  const existing = new Set(
    db
      .select({ title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.conversationId, m.conversationId), isNull(tasks.deletedAt)))
      .all()
      .map((t) => t.title.toLowerCase()),
  );
  let added = 0;
  for (const t of (out.task ?? []).slice(0, MAX_TASKS)) {
    const title = t.titolo?.trim() ? toFirstPerson(t.titolo.trim()) : '';
    if (!title || existing.has(title.toLowerCase())) continue;
    const due = t.scadenza && /^\d{4}-\d{2}-\d{2}$/.test(t.scadenza) ? t.scadenza : null;
    const payload: TaskSuggestionPayload = { title: title.slice(0, 200), dueDate: due, details: t.dettagli?.trim() || null, messageId };
    db.insert(suggestions)
      .values({
        id: newId(),
        kind: 'task',
        subjectType: 'conversation',
        subjectId: m.conversationId,
        payload: JSON.stringify(payload),
        confidence: null,
        status: 'pending',
        model: config.ollama.llmModel,
        createdAt: now(),
      })
      .run();
    added++;
  }
  if (added) bus.publish({ type: 'conversations', ids: [m.conversationId] });
}
