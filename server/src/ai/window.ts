// Finestra dell'analisi con l'IA: sintesi, classificazione, task e azioni suggerite si fanno solo sulla
// posta recente (ultimi N giorni, dalle impostazioni; 0 = tutta). La posta vecchia resta cercabile
// (l'indicizzazione vale per tutto lo storico) e la sua sintesi si genera su richiesta.

import { eq, gte, sql, type SQL } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import { conversations, settings } from '../db/schema.ts';
import { DEFAULT_SETTINGS } from '@mmw/shared';

/** Lavori che usano il modello linguistico (l'indicizzazione no: è veloce e serve alla ricerca). */
export const LLM_JOB_KINDS = ['summarize', 'classify', 'extract_tasks', 'suggest_actions'] as const;

let cached: { at: number; days: number } | null = null;

/** Giorni della finestra (0 = tutta la posta). Letto dalle impostazioni, con qualche secondo di cache. */
export function aiWindowDays(db: Db): number {
  if (cached && Date.now() - cached.at < 5000) return cached.days;
  const row = db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'aiWindowDays')).get();
  const v = row ? Number(JSON.parse(row.value)) : DEFAULT_SETTINGS.aiWindowDays;
  const days = Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.aiWindowDays;
  cached = { at: Date.now(), days };
  return days;
}

/** Da rileggere subito dopo un cambio nelle impostazioni. */
export function forgetAiWindow() {
  cached = null;
}

/** Inizio della finestra in millisecondi; null = nessun limite. */
export function aiCutoff(db: Db): number | null {
  const days = aiWindowDays(db);
  return days > 0 ? Date.now() - days * 86_400_000 : null;
}

/** Condizione SQL "conversazione dentro la finestra" (per gli accodamenti in blocco). */
export function inWindowSql(db: Db): SQL {
  const cutoff = aiCutoff(db);
  return cutoff === null ? sql`1 = 1` : gte(conversations.lastMessageAt, cutoff);
}

/** La conversazione ha avuto messaggi dentro la finestra. */
export function conversationInWindow(db: Db, conversationId: string): boolean {
  const cutoff = aiCutoff(db);
  if (cutoff === null) return true;
  const r = db.$client.prepare('select last_message_at as t from conversations where id = ?').get(conversationId) as { t: number | null } | undefined;
  return !!r && (r.t ?? 0) >= cutoff;
}

/** Il messaggio è dentro la finestra. */
export function messageInWindow(db: Db, messageId: string): boolean {
  const cutoff = aiCutoff(db);
  if (cutoff === null) return true;
  const r = db.$client.prepare('select date as t from messages where id = ?').get(messageId) as { t: number | null } | undefined;
  return !!r && (r.t ?? 0) >= cutoff;
}

/**
 * Allinea la coda alla finestra: toglie i lavori sulla posta fuori finestra e accoda quelli mancanti
 * dentro (all'avvio e quando la finestra cambia nelle impostazioni). Restituisce quanti ne ha tolti.
 */
export function applyAiWindow(db: Db, sqlite: Database.Database, enqueueMissing: () => void): number {
  forgetAiWindow();
  let removed = 0;
  sqlite.transaction(() => {
    removed = pruneOutOfWindow(db, sqlite);
    enqueueMissing();
  })();
  return removed;
}

/** Toglie dalla coda i lavori del modello linguistico sulla posta fuori dalla finestra. */
export function pruneOutOfWindow(db: Db, sqlite: Database.Database): number {
  const cutoff = aiCutoff(db);
  if (cutoff === null) return 0;
  const byConversation = sqlite
    .prepare(
      `delete from jobs where status = 'pending' and kind in ('summarize', 'classify')
         and (select c.last_message_at from conversations c where c.id = json_extract(jobs.payload, '$.conversationId')) < ?`,
    )
    .run(cutoff).changes;
  const byMessage = sqlite
    .prepare(
      `delete from jobs where status = 'pending' and kind in ('extract_tasks', 'suggest_actions')
         and (select m.date from messages m where m.id = json_extract(jobs.payload, '$.messageId')) < ?`,
    )
    .run(cutoff).changes;
  return byConversation + byMessage;
}
