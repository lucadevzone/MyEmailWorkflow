import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ActivityDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { button, ghost } from '../ui/styles.ts';

const STATUS: Record<ActivityDto['status'], { label: string; cls: string }> = {
  pending: { label: 'In attesa', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  running: { label: 'In corso', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  failed: { label: 'Fallita', cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300' },
  done: { label: 'Eseguita', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
  cancelled: { label: 'Annullata', cls: 'bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-400' },
};

function useCountdown(target: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!target) return null;
  const s = Math.max(0, Math.round((target - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ActivitiesPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['activities'], queryFn: api.activities });
  const countdown = useCountdown(data?.nextRunAt ?? null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['activities'] });
  const op = useMutation({
    mutationFn: ({ kind, id }: { kind: 'cancel' | 'run' | 'retry' | 'all'; id?: string }) =>
      kind === 'all'
        ? api.runAllActivities()
        : kind === 'cancel'
          ? api.cancelActivity(id!)
          : kind === 'run'
            ? api.runActivity(id!)
            : api.retryActivity(id!),
    onSettled: refresh,
  });

  const list = data?.activities ?? [];
  const open = list.filter((a) => a.status === 'pending' || a.status === 'running' || a.status === 'failed');
  const closed = list.filter((a) => a.status === 'done' || a.status === 'cancelled');

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Attività</h1>
          <p className="text-sm text-stone-500">
            Operazioni sul server di posta in attesa di esecuzione. Finché non partono puoi annullarle.
            {countdown && <> Prossima esecuzione tra {countdown}.</>}
          </p>
        </div>
        <button
          className={button}
          disabled={!open.some((a) => a.status === 'pending') || op.isPending}
          onClick={() => op.mutate({ kind: 'all' })}
        >
          Esegui tutto ora
        </button>
      </div>
      {op.error && <div className="text-sm text-rose-600">{(op.error as Error).message}</div>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Da eseguire</h2>
        {open.length === 0 && <p className="text-sm text-stone-500">Nessuna attività in attesa.</p>}
        <ul hidden={open.length === 0} className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
          {open.map((a) => (
            <Row key={a.id} a={a}>
              {a.status === 'pending' && (
                <>
                  <button className={ghost} onClick={() => op.mutate({ kind: 'run', id: a.id })}>
                    Esegui ora
                  </button>
                  <button className={ghost} onClick={() => op.mutate({ kind: 'cancel', id: a.id })}>
                    Annulla
                  </button>
                </>
              )}
              {a.status === 'failed' && (
                <>
                  <button className={ghost} onClick={() => op.mutate({ kind: 'retry', id: a.id })}>
                    Riprova
                  </button>
                  <button className={ghost} onClick={() => op.mutate({ kind: 'cancel', id: a.id })}>
                    Annulla
                  </button>
                </>
              )}
            </Row>
          ))}
        </ul>
      </section>

      {closed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Eseguite di recente</h2>
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
            {closed.map((a) => (
              <Row key={a.id} a={a} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({ a, children }: { a: ActivityDto; children?: React.ReactNode }) {
  const s = a.kind === 'send' && a.status === 'done' ? { ...STATUS.done, label: 'Inviata' } : STATUS[a.status];
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="truncate">{a.label}</span>
          {a.urgent && (
            <span className="shrink-0 rounded bg-rose-100 px-1 text-[10px] font-medium uppercase text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
              urgente
            </span>
          )}
        </div>
        {a.lastError && <div className="truncate text-xs text-rose-600">{a.lastError}</div>}
      </div>
      <span className="shrink-0 text-xs text-stone-500 tabular-nums">{shortDate(a.executedAt ?? a.createdAt)}</span>
      <div className="flex shrink-0 gap-1">{children}</div>
    </li>
  );
}
