import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { ActivityDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { useBlockSend } from './blockSend.ts';

const STATUS: Record<ActivityDto['status'], string> = {
  pending: 'In attesa',
  running: 'In corso',
  failed: 'Non riuscita',
  done: 'Eseguita',
  cancelled: 'Annullata',
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

/**
 * O3 · Pannello Attività: la coda delle operazioni sul server di posta (invii, letture, archiviazioni…).
 * Si apre dalla barra di stato; finché un'attività non parte si può annullare o eseguire subito.
 */
export function ActivitiesPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['activities'], queryFn: api.activities });
  const countdown = useCountdown(data?.nextRunAt ?? null);
  const block = useBlockSend();
  const op = useMutation({
    mutationFn: ({ kind, id }: { kind: 'cancel' | 'run' | 'retry' | 'all'; id?: string }) =>
      kind === 'all' ? api.runAllActivities() : kind === 'cancel' ? api.cancelActivity(id!) : kind === 'run' ? api.runActivity(id!) : api.retryActivity(id!),
    onSettled: () => {
      for (const k of [['activities'], ['conversations'], ['counts']]) qc.invalidateQueries({ queryKey: k });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest('[data-activities-toggle]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  const list = data?.activities ?? [];
  const open = list.filter((a) => a.status === 'pending' || a.status === 'running' || a.status === 'failed');
  const closed = list.filter((a) => a.status === 'done' || a.status === 'cancelled').slice(0, 20);

  return (
    <div className="pm-activities" ref={ref} role="dialog" aria-label="Attività">
      <div className="pm-activities__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pm-activities__title">Attività</div>
          <div className="pm-row__sub">
            Operazioni sul server di posta. Finché non partono puoi annullarle.
            {countdown && open.some((a) => a.status === 'pending') && <> Prossimo invio tra {countdown}.</>}
          </div>
        </div>
        <button
          type="button"
          className="pm-btn pm-btn--secondary pm-btn--xs"
          disabled={!open.some((a) => a.status === 'pending') || op.isPending}
          onClick={() => op.mutate({ kind: 'all' })}
        >
          Esegui tutto ora
        </button>
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Chiudi" onClick={onClose}>
          <Ic icon={X} />
        </button>
      </div>
      <div className="pm-activities__body">
        {op.error && <div className="pm-draft__error" style={{ padding: '8px 16px 0' }}>{(op.error as Error).message}</div>}
        <div className="pm-label pm-activities__section">Da eseguire · {open.length}</div>
        {open.length === 0 && <div className="pm-activities__empty">Nessuna attività in attesa.</div>}
        {open.map((a) => (
          <Row key={a.id} a={a}>
            {a.status === 'pending' && (
              <>
                <button type="button" className="pm-btn pm-btn--ghost pm-btn--xs" onClick={() => op.mutate({ kind: 'run', id: a.id })}>
                  Esegui ora
                </button>
                {a.kind === 'send' && (
                  <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" title="Non inviare: rimetti la mail in bozza per modificarla"
                    onClick={() => void block.byActivity(a.id).then(onClose)}>
                    Blocca invio
                  </button>
                )}
                <button type="button" className="pm-btn pm-btn--danger pm-btn--xs" onClick={() => op.mutate({ kind: 'cancel', id: a.id })}>
                  Annulla
                </button>
              </>
            )}
            {a.status === 'failed' && (
              <>
                <button type="button" className="pm-btn pm-btn--ghost pm-btn--xs" onClick={() => op.mutate({ kind: 'retry', id: a.id })}>
                  Riprova
                </button>
                {a.kind === 'send' && (
                  <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" title="Rimetti la mail in bozza per modificarla"
                    onClick={() => void block.byActivity(a.id).then(onClose)}>
                    Rimetti in bozza
                  </button>
                )}
                <button type="button" className="pm-btn pm-btn--danger pm-btn--xs" onClick={() => op.mutate({ kind: 'cancel', id: a.id })}>
                  Annulla
                </button>
              </>
            )}
          </Row>
        ))}
        {closed.length > 0 && (
          <>
            <div className="pm-label pm-activities__section">Di recente</div>
            {closed.map((a) => (
              <Row key={a.id} a={a} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ a, children }: { a: ActivityDto; children?: React.ReactNode }) {
  const label = a.kind === 'send' && a.status === 'done' ? 'Inviata' : STATUS[a.status];
  return (
    <div className="pm-activity">
      <span className={`pm-activity__status pm-activity__status--${a.status}`}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="pm-activity__label">
          <span className="pm-truncate">{a.label}</span>
          {a.urgent && <span className="pm-activity__urgent">urgente</span>}
        </div>
        {a.lastError && <div className="pm-activity__error">{a.lastError}</div>}
      </div>
      <span className="pm-row__sub" style={{ flex: 'none' }}>{shortDate(a.executedAt ?? a.createdAt)}</span>
      {children && <div className="pm-activity__actions">{children}</div>}
    </div>
  );
}
