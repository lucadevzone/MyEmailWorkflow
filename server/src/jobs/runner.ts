import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { jobs } from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import { PRIORITY, setJobNotifier } from './queue.ts';

export type JobHandler = (payload: unknown) => Promise<void>;

const MAX_ATTEMPTS = 5;

/** Esegue i lavori uno alla volta, per priorità; in caso di errore riprova con backoff. */
export class JobRunner {
  private handlers = new Map<string, JobHandler>();
  private running = false;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;

  /** paused: quando è vero non si prendono lavori nuovi (quello in corso finisce). */
  constructor(private db: Db, private paused: () => boolean = () => false) {}

  register(kind: string, handler: JobHandler) {
    this.handlers.set(kind, handler);
  }

  start() {
    this.stopped = false;
    setJobNotifier(() => this.kick());
    this.db.update(jobs).set({ status: 'pending' }).where(eq(jobs.status, 'running')).run();
    this.kick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Da chiamare dopo aver accodato un lavoro. */
  kick() {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), 50);
    this.timer.unref?.();
  }

  /** Per i test: esegue tutto ciò che è pronto. */
  async drain() {
    while (await this.runOne()) {}
  }

  private async loop() {
    this.running = true;
    try {
      while (!this.stopped && (await this.runOne())) {}
    } finally {
      this.running = false;
    }
    if (!this.stopped) {
      // Ricontrolla periodicamente i lavori rimandati (backoff).
      this.timer = setTimeout(() => void this.loop(), 30_000);
      this.timer.unref?.();
    }
  }

  /** Lavori in attesa per tipo, e quello in corso (per la barra di stato). */
  status(): { pending: number; byKind: Record<string, number>; running: string | null } {
    const rows = this.db
      .select({ kind: jobs.kind, status: jobs.status, n: sql<number>`count(*)` })
      .from(jobs)
      .where(sql`${jobs.status} in ('pending', 'running')`)
      .groupBy(jobs.kind, jobs.status)
      .all();
    const byKind: Record<string, number> = {};
    let running: string | null = null;
    for (const r of rows) {
      if (r.status === 'running') running = r.kind;
      else byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
    }
    return { pending: Object.values(byKind).reduce((a, b) => a + b, 0), byKind, running };
  }

  private async runOne(): Promise<boolean> {
    // In pausa girano solo i lavori della conversazione aperta dall'utente.
    const paused = this.paused();
    const job = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.runAfter, now()), paused ? gte(jobs.priority, PRIORITY.focus) : undefined))
      // A parità di priorità e di momento (stessa email), prima l'indicizzazione: la classificazione
      // usa la somiglianza, che richiede gli embedding della conversazione.
      .orderBy(desc(jobs.priority), asc(jobs.createdAt), asc(sql`case ${jobs.kind} when 'embed' then 0 when 'classify' then 2 else 1 end`))
      .get();
    if (!job) return false;
    const handler = this.handlers.get(job.kind);
    this.db.update(jobs).set({ status: 'running', attempts: job.attempts + 1, updatedAt: now() }).where(eq(jobs.id, job.id)).run();
    try {
      if (!handler) throw new Error(`Nessun gestore per ${job.kind}`);
      await handler(JSON.parse(job.payload));
      this.db.delete(jobs).where(eq(jobs.id, job.id)).run();
    } catch (err) {
      const attempts = job.attempts + 1;
      const t = now();
      this.db
        .update(jobs)
        .set({
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          runAfter: t + Math.min(60_000 * 2 ** attempts, 3_600_000),
          lastError: (err as Error).message,
          updatedAt: t,
        })
        .where(eq(jobs.id, job.id))
        .run();
    }
    return true;
  }
}
