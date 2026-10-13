// Indicatore "Stato" in alto a destra (UI v2, sostituisce la barra di stato): un pallino riassume tutto
// (verde = operativo, arancio = LLM non pronto, rosso = account offline); il pannello mostra gli account,
// Ollama, l'analisi in background (con pausa) e la coda delle Attività.

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListTodo, Pause, Play } from 'lucide-react';
import type { SyncStatusDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useSyncStatuses } from '../events.ts';
import { ActivitiesPanel } from '../activities/ActivitiesPanel.tsx';

const PHASE: Record<SyncStatusDto['phase'], string> = {
  stopped: 'fermo',
  connecting: 'connessione…',
  initial: 'importazione posta recente…',
  catchup: 'aggiornamento…',
  backfill: 'importazione storico…',
  idle: 'aggiornato',
  error: 'errore',
};

const KIND: Record<string, string> = {
  summarize: 'sintesi',
  classify: 'classificazione',
  embed: 'indicizzazione per la ricerca',
  extract_tasks: 'task suggeriti',
  suggest_actions: 'azioni suggerite',
};

const time = (t: number) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

export function StatusMenu() {
  const qc = useQueryClient();
  const statuses = useSyncStatuses();
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const { data: activities } = useQuery({ queryKey: ['activities'], queryFn: api.activities });
  const { data: jobs } = useQuery({ queryKey: ['jobs-status'], queryFn: api.jobsStatus, refetchInterval: 5000 });
  const pause = useMutation({
    mutationFn: (aiPaused: boolean) => api.updateSettings({ aiPaused }),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      qc.invalidateQueries({ queryKey: ['jobs-status'] });
    },
  });
  const [open, setOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const queued = activities?.activities.filter((a) => a.status === 'pending' || a.status === 'running').length ?? 0;
  const failed = activities?.activities.filter((a) => a.status === 'failed').length ?? 0;
  const ollamaOk = !!health?.ollama.ok && !!health.config.llmAvailable;
  const rows = accounts.map((a) => {
    const s = statuses.find((x) => x.accountId === a.id);
    const online = !!s && s.phase !== 'error' && s.phase !== 'stopped' && s.phase !== 'connecting';
    return { a, s, online };
  });
  const level = rows.some((r) => !r.online) || failed ? 'off' : !ollamaOk ? 'warn' : 'ok';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const jobsDetail = jobs
    ? Object.entries(jobs.byKind)
        .map(([k, n]) => `${n.toLocaleString('it-IT')} ${KIND[k] ?? k}`)
        .join(', ')
    : '';

  return (
    <div className="pm-statusmenu" ref={ref}>
      <button type="button" className="pm-statusbtn" aria-expanded={open} aria-haspopup="dialog" data-activities-toggle onClick={() => setOpen(!open)}>
        <span className={`pm-dot pm-dot--${level}`} aria-hidden="true" />
        Stato
      </button>
      {open && (
        <div className="pm-popover pm-statuspanel" role="dialog" aria-label="Stato">
          <div className="pm-statuspanel__title">Stato</div>
          {rows.map(({ a, s, online }) => {
            const busy = s && (s.phase === 'initial' || s.phase === 'catchup' || s.phase === 'backfill');
            const detail = !s
              ? 'non avviato'
              : s.phase === 'error'
                ? `offline · ${s.error ?? 'errore di connessione'}`
                : s.phase === 'idle'
                  ? `online · sincronizzato alle ${time(s.updatedAt)}`
                  : `${online ? 'online · ' : ''}${PHASE[s.phase]}${busy && s.imported ? ` ${s.imported.toLocaleString('it-IT')} messaggi` : ''}`;
            return (
              <div key={a.id} className="pm-statuspanel__row">
                <span className={`pm-dot pm-dot--${online ? 'ok' : 'off'}`} aria-hidden="true" />
                <div className="pm-statuspanel__text">
                  <div className="pm-statuspanel__name" title={a.email}>{a.name}</div>
                  <div className="pm-statuspanel__sub">{detail}</div>
                </div>
              </div>
            );
          })}
          <div className="pm-statuspanel__row">
            <span className={`pm-dot pm-dot--${ollamaOk ? 'ok' : 'warn'}`} aria-hidden="true" />
            <div className="pm-statuspanel__text">
              <div className="pm-statuspanel__name">Ollama</div>
              <div className="pm-statuspanel__sub">
                {!health ? 'controllo…' : ollamaOk ? `${health.config.llmModel} · pronto` : health.ollama.error ?? `modello ${health.config.llmModel} non disponibile`}
              </div>
            </div>
          </div>
          {jobs && (
            <div className="pm-statuspanel__row">
              <Ic icon={jobs.paused ? Pause : Play} size={15} />
              <div className="pm-statuspanel__text">
                <div className="pm-statuspanel__name">Analisi</div>
                <div className="pm-statuspanel__sub" title={jobsDetail ? `In coda: ${jobsDetail}` : undefined}>
                  {jobs.paused
                    ? `in pausa · ${jobs.pending.toLocaleString('it-IT')} in attesa · posta nuova e conversazioni aperte sì`
                    : jobs.pending || jobs.running
                      ? `${jobs.running ? `ora: ${KIND[jobs.running] ?? jobs.running} · ` : ''}${jobs.pending.toLocaleString('it-IT')} in coda`
                      : 'niente da analizzare'}
                </div>
              </div>
              <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" disabled={pause.isPending} onClick={() => pause.mutate(!jobs.paused)}>
                {jobs.paused ? 'Riprendi' : 'Pausa'}
              </button>
            </div>
          )}
          <div className="pm-statuspanel__row">
            <Ic icon={ListTodo} size={15} />
            <div className="pm-statuspanel__text">
              <div className="pm-statuspanel__name">Attività</div>
              <div className="pm-statuspanel__sub">
                {queued ? `${queued} in coda` : 'nessuna in coda'}
                {failed ? <span style={{ color: 'var(--danger)' }}> · {failed} fallite</span> : null}
              </div>
            </div>
            <button
              type="button"
              className="pm-btn pm-btn--secondary pm-btn--sm"
              onClick={() => {
                setOpen(false);
                setActivitiesOpen(true);
              }}
            >
              Apri
            </button>
          </div>
          <div className="pm-statuspanel__legend" aria-hidden="true">
            <span><span className="pm-dot pm-dot--ok" /> tutto operativo</span>
            <span><span className="pm-dot pm-dot--warn" /> LLM non pronto</span>
            <span><span className="pm-dot pm-dot--off" /> account offline</span>
          </div>
        </div>
      )}
      {activitiesOpen && <ActivitiesPanel onClose={() => setActivitiesOpen(false)} />}
    </div>
  );
}
