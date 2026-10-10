// Task suggeriti: richieste e scadenze rivolte all'utente in un messaggio in arrivo (solo posta recente).

import { and, desc, eq, gt, isNull, like, lt } from 'drizzle-orm';
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
  'che nessuno ha chiesto. Non proporre il generico "rispondere": servono azioni concrete legate al contenuto. ' +
  'Spesso non ci sono richieste, o ce n\'è una sola. Scrivi in italiano. Rispondi solo con un oggetto JSON.';

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

const IMPERATIVE: Record<string, string> = {
  mandami: 'Inviare', inviami: 'Inviare', manda: 'Inviare', invia: 'Inviare', mandare: 'Inviare',
  rispondi: 'Rispondere', scrivi: 'Scrivere', scrivimi: 'Scrivere', fammi: 'Far', dimmi: 'Comunicare',
  indica: 'Indicare', indicami: 'Indicare', conferma: 'Confermare', confermami: 'Confermare',
  controlla: 'Controllare', verifica: 'Verificare', prepara: 'Preparare', preparami: 'Preparare',
  leggi: 'Leggere', compila: 'Compilare', firma: 'Firmare', carica: 'Caricare', aggiorna: 'Aggiornare',
};

/** I task sono all'infinito: "Mandami i timesheet" → "Inviare i timesheet", "rispondi…" → "Rispondere…". */
export function toInfinitive(title: string): string {
  const m = /^(\S+)(.*)$/s.exec(title.trim());
  if (!m) return title;
  const [, first, rest] = m as unknown as [string, string, string];
  const w = first.toLowerCase();
  let verb = IMPERATIVE[w];
  // Imperativo regolare in -a (eventualmente con "-mi"): "prenota" → "Prenotare".
  if (!verb && /^[a-zàèéìòù]{3,}(a|ami)$/.test(w) && !/are$/.test(w)) verb = w.replace(/(ami|a)$/, 'are');
  if (!verb) return title.charAt(0).toUpperCase() + title.slice(1);
  return verb.charAt(0).toUpperCase() + verb.slice(1) + rest;
}

const EXAMPLE_TITLE = 'Prenotare la sala riunioni';

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
  /** Vecchio suggerimento "rispondere a questa email": ora è un task di default creato dall'utente. */
  reply?: boolean;
}

/**
 * Una risposta è partita (o è stata vista dal sync): i task aperti "Rispondere a…" della conversazione
 * creati prima della risposta si completano da soli.
 */
export function completeReplyTasks(db: Db, conversationId: string, repliedAt: number): number {
  const open = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.conversationId, conversationId),
        eq(tasks.status, 'open'),
        isNull(tasks.deletedAt),
        like(tasks.title, 'Rispondere a %'),
        lt(tasks.createdAt, repliedAt),
      ),
    )
    .all();
  const t = now();
  for (const r of open) db.update(tasks).set({ status: 'done', completedAt: t, updatedAt: t }).where(eq(tasks.id, r.id)).run();
  if (open.length) bus.publish({ type: 'tasks' });
  return open.length;
}

/** Toglie il suggerimento "rispondere" in attesa: quando si risponde non serve più. */
export function clearReplySuggestion(db: Db, conversationId: string) {
  const pending = db
    .select({ id: suggestions.id, payload: suggestions.payload })
    .from(suggestions)
    .where(and(eq(suggestions.subjectId, conversationId), eq(suggestions.kind, 'task'), eq(suggestions.status, 'pending')))
    .all()
    .filter((r) => (JSON.parse(r.payload) as TaskSuggestionPayload).reply);
  for (const r of pending) db.delete(suggestions).where(eq(suggestions.id, r.id)).run();
  return pending.length > 0;
}

function saveTask(db: Db, conversationId: string, payload: TaskSuggestionPayload) {
  // L'estrazione può ripartire sullo stesso messaggio (recupero all'avvio): niente doppioni.
  const dup = db
    .select({ payload: suggestions.payload })
    .from(suggestions)
    .where(and(eq(suggestions.subjectId, conversationId), eq(suggestions.kind, 'task')))
    .all()
    .some((r) => {
      const p = JSON.parse(r.payload) as TaskSuggestionPayload;
      return p.messageId === payload.messageId && p.title.toLowerCase() === payload.title.toLowerCase();
    });
  if (dup) return false;
  db.insert(suggestions)
    .values({
      id: newId(),
      kind: 'task',
      subjectType: 'conversation',
      subjectId: conversationId,
      payload: JSON.stringify(payload),
      confidence: null,
      status: 'pending',
      model: payload.reply ? null : config.ollama.llmModel,
      createdAt: now(),
    })
    .run();
  return true;
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
  // Se l'analizzatore ha già stabilito che il messaggio non chiede nulla (archivia/rumore), niente task.
  const verdict = db
    .select({ payload: suggestions.payload })
    .from(suggestions)
    .where(and(eq(suggestions.subjectId, m.conversationId), eq(suggestions.kind, 'action'), eq(suggestions.status, 'pending')))
    .all()
    .map((r) => JSON.parse(r.payload) as { action: string; messageId: string })
    .find((p) => p.messageId === messageId);
  if (verdict && verdict.action !== 'reply') return;

  const when = new Date(m.date);
  const prompt = [
    `Da: ${m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}`,
    `Oggetto: ${m.subject ?? ''}`,
    '',
    text,
    '',
    'Esempio (solo per la forma, da non copiare): il messaggio "Puoi prenotare la sala riunioni per lunedì?"',
    `diventa {"task": [{"titolo": "${EXAMPLE_TITLE}", "scadenza": "<data di lunedì dal calendario>", "dettagli": null}]}.`,
    '',
    'Calendario per risolvere le date relative ("venerdì", "domani", "la prossima settimana"):',
    calendarFrom(when),
    '',
    `Rispondi con un JSON {"task": [...]}, al massimo ${MAX_TASKS} elementi, lista vuota se il mittente non chiede nulla al destinatario.`,
    // Niente esempi concreti: il modello tende a copiarli come task.
    'Ogni elemento: {"titolo": frase breve che inizia con un verbo all\'infinito, dal punto di vista del destinatario, senza "tuo/tua",',
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
    const title = t.titolo?.trim() ? toInfinitive(toFirstPerson(t.titolo.trim())) : '';
    // "Rispondere…" generico è il task di default (lo crea l'utente); l'esempio del prompt non è un task.
    if (!title || existing.has(title.toLowerCase()) || /^rispond/i.test(title) || title === EXAMPLE_TITLE) continue;
    // Segnaposto del modello per "nessun task" ("Niente da fare", "Nessuna richiesta").
    if (/^(niente|nessun[oa]?)\b/i.test(title)) continue;
    const due = t.scadenza && /^\d{4}-\d{2}-\d{2}$/.test(t.scadenza) ? t.scadenza : null;
    if (saveTask(db, m.conversationId, { title: title.slice(0, 200), dueDate: due, details: t.dettagli?.trim() || null, messageId })) added++;
  }
  if (added) bus.publish({ type: 'conversations', ids: [m.conversationId] });
}

/**
 * All'avvio: per le conversazioni aperte (non News, non archiviate) il cui ultimo messaggio è arrivato e
 * non ha ancora risposta, se manca qualsiasi suggerimento di task si rimette in coda l'estrazione
 * Recupera la posta già presente quando i suggerimenti sono andati persi. Toglie i vecchi suggerimenti
 * "Rispondere a…" automatici: quel task ora si crea a mano.
 */
export function enqueueMissingTaskExtraction(db: Db) {
  const stale = db.select({ subjectId: suggestions.subjectId }).from(suggestions).where(and(eq(suggestions.kind, 'task'), eq(suggestions.status, 'pending'))).all();
  for (const id of new Set(stale.map((r) => r.subjectId))) clearReplySuggestion(db, id);
  const convs = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(isNull(conversations.deletedAt), isNull(conversations.archivedAt), eq(conversations.isNoise, false)))
    .all();
  for (const c of convs) {
    const lastMsg = db
      .select({ id: messages.id, direction: messages.direction })
      .from(messages)
      .where(and(eq(messages.conversationId, c.id), isNull(messages.deletedAt)))
      .orderBy(desc(messages.date))
      .get();
    if (!lastMsg || lastMsg.direction !== 'in') continue;
    const hasSuggestion = db
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(and(eq(suggestions.subjectId, c.id), eq(suggestions.kind, 'task')))
      .get();
    if (!hasSuggestion) enqueueJob(db, 'extract_tasks', { messageId: lastMsg.id }, PRIORITY.background);
  }
}
