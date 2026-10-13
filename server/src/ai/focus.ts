// Conversazione aperta dall'utente: la sua analisi mancante passa davanti a tutto, anche con l'analisi in
// background in pausa (PRIORITY.focus). Solo dentro la finestra dell'analisi: per la posta più vecchia la
// sintesi resta su richiesta.

import type { Db } from '../db/client.ts';
import { enqueueJob, PRIORITY } from '../jobs/queue.ts';
import { conversationInWindow } from './window.ts';

export interface FocusResult {
  /** Lavori messi (o portati) in primo piano. */
  queued: string[];
  /** Perché non si è fatto nulla. */
  skipped?: 'not_found' | 'noise' | 'window';
}

export function analyzeFocused(db: Db, conversationId: string): FocusResult {
  const sqlite = db.$client;
  const c = sqlite
    .prepare(
      `select id, project_id as projectId, is_noise as noise, is_spam as spam, archived_at as archivedAt, classified_at as classifiedAt,
              summary, summary_updated_at as summaryAt, last_message_at as lastAt
         from conversations where id = ? and deleted_at is null`,
    )
    .get(conversationId) as
    | { id: string; projectId: string | null; noise: number; spam: number; archivedAt: number | null; classifiedAt: number | null; summary: string | null; summaryAt: number | null; lastAt: number }
    | undefined;
  if (!c) return { queued: [], skipped: 'not_found' };
  if (c.noise || c.spam) return { queued: [], skipped: 'noise' };
  if (!conversationInWindow(db, conversationId)) return { queued: [], skipped: 'window' };
  const queued: string[] = [];
  // Ordine dentro il primo piano: prima la sintesi (la si vede subito), poi indicizzazione e
  // classificazione (che usa la somiglianza), infine task e azioni suggerite.
  const ORDER: Record<string, number> = { summarize: 3, embed: 2, classify: 1 };
  const add = (kind: string, payload: object) => {
    enqueueJob(db, kind, payload, PRIORITY.focus + (ORDER[kind] ?? 0));
    queued.push(kind);
  };

  // Indicizzazione dei messaggi che non l'hanno ancora: la classificazione usa la somiglianza.
  const unindexed = sqlite
    .prepare(
      `select m.id from messages m where m.conversation_id = ? and m.deleted_at is null
          and not exists (select 1 from chunks ch where ch.message_id = m.id)`,
    )
    .all(conversationId) as { id: string }[];
  for (const m of unindexed) add('embed', { messageId: m.id });

  // Sintesi mancante, o più vecchia dell'ultimo messaggio.
  if (!c.summary || (c.summaryAt ?? 0) < c.lastAt) add('summarize', { conversationId });

  // Classificazione: solo in Da smistare, aperta e non ancora valutata.
  if (!c.projectId && !c.archivedAt && !c.classifiedAt) add('classify', { conversationId });

  // Task e azioni suggerite sull'ultimo messaggio arrivato, se non sono mai stati proposti.
  const last = sqlite
    .prepare(`select id, direction from messages where conversation_id = ? and deleted_at is null order by date desc limit 1`)
    .get(conversationId) as { id: string; direction: string } | undefined;
  if (last?.direction === 'in' && !c.archivedAt) {
    const has = (kind: string) =>
      !!sqlite.prepare(`select 1 from suggestions where subject_type = 'conversation' and subject_id = ? and kind = ? limit 1`).get(conversationId, kind);
    if (!has('task')) add('extract_tasks', { messageId: last.id });
    if (!has('action')) add('suggest_actions', { messageId: last.id });
  }
  return { queued };
}
