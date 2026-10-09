import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { Clock, ListTodo } from 'lucide-react';
import type { SyncStatusDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useSyncStatuses } from '../events.ts';
import { paths } from './paths.ts';

const PHASE: Record<SyncStatusDto['phase'], string> = {
  stopped: 'fermo',
  connecting: 'connessione…',
  initial: 'importazione posta recente…',
  backfill: 'importazione storico…',
  idle: 'aggiornato',
  error: 'errore',
};

/** Barra di stato (D1): solo i processi interni — coda Attività e stato delle connessioni. */
export function StatusBar() {
  const statuses = useSyncStatuses();
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const { data: activities } = useQuery({ queryKey: ['activities'], queryFn: api.activities });
  const queued = activities?.activities.filter((a) => a.status === 'pending' || a.status === 'running').length ?? 0;
  const failed = activities?.activities.filter((a) => a.status === 'failed').length ?? 0;
  const ollamaOk = !!health?.ollama.ok && !!health.config.llmAvailable;

  return (
    <footer className="pm-statusbar">
      <NavLink to={paths.activities()} className="pm-btn pm-btn--secondary pm-btn--xs" title="Coda delle attività">
        <Ic icon={ListTodo} size={15} />
        <Ic icon={Clock} size={15} />
        Attività{queued ? ` · ${queued} in coda` : ''}
        {failed ? <span style={{ color: 'var(--danger)' }}> · {failed} fallite</span> : null}
      </NavLink>
      {accounts.map((a) => {
        const s = statuses.find((x) => x.accountId === a.id);
        const online = !!s && s.phase !== 'error' && s.phase !== 'stopped' && s.phase !== 'connecting';
        const busy = s && (s.phase === 'initial' || s.phase === 'backfill');
        return (
          <span key={a.id} className={`pm-status${online ? '' : ' pm-status--off'}`} title={s?.error ?? `${a.email}: ${s ? PHASE[s.phase] : 'non avviato'}`}>
            {a.name}
            {busy && <span className="pm-status__detail">· {PHASE[s.phase]}</span>}
          </span>
        );
      })}
      <span
        className={`pm-status${ollamaOk ? '' : ' pm-status--off'}`}
        title={health ? (ollamaOk ? `${health.config.llmModel} su ${health.ollama.url}` : health.ollama.error ?? `Modello ${health.config.llmModel} non disponibile`) : 'Controllo…'}
      >
        Ollama
      </span>
    </footer>
  );
}
