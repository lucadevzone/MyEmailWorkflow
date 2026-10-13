// Coda interna dei lavori in background (invisibile all'utente): sintesi, e da M4 analisi ed embedding.

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { jobs } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';

/**
 * idle = quando non c'è altro (es. indicizzare lo storico, dopo l'analisi della posta recente);
 * fresh = posta appena ricevuta (ultime 48 ore): gira anche con l'analisi in pausa;
 * focus = la conversazione che l'utente ha aperto: passa davanti a tutto, anche in pausa.
 */
export const PRIORITY = { idle: -10, background: 0, normal: 10, fresh: 50, focus: 100 } as const;

/** Da questa priorità in su i lavori girano anche con l'analisi in background in pausa. */
export const RUNS_WHEN_PAUSED = PRIORITY.fresh;

/** Posta "appena ricevuta": arrivata nelle ultime 48 ore. */
export const FRESH_MS = 48 * 3_600_000;

let notify: () => void = () => {};
/** Il JobRunner si registra qui per essere svegliato quando arriva un lavoro. */
export function setJobNotifier(fn: () => void) {
  notify = fn;
}

/** Accoda un lavoro; se ne esiste già uno identico in attesa, lo riusa (alzandone la priorità). */
export function enqueueJob(db: Db, kind: string, payload: object, priority: number = PRIORITY.normal): void {
  const json = JSON.stringify(payload);
  const t = now();
  const existing = db
    .select({ id: jobs.id, priority: jobs.priority })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.payload, json), eq(jobs.status, 'pending')))
    .get();
  if (existing) {
    if (priority > existing.priority) db.update(jobs).set({ priority, updatedAt: t }).where(eq(jobs.id, existing.id)).run();
    notify();
    return;
  }
  db.insert(jobs)
    .values({ id: newId(), kind, payload: json, priority, status: 'pending', runAfter: t, createdAt: t, updatedAt: t })
    .run();
  notify();
}
