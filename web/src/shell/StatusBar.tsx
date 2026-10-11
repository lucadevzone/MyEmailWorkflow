import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Clock, ListTodo, Pause, Play } from 'lucide-react';
import type { SyncStatusDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useSyncStatuses } from '../events.ts';
import { ActivitiesPanel } from '../activities/ActivitiesPanel.tsx';

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
  const [panel, setPanel] = useState(false);

  return (
    <footer className="pm-statusbar">
      <button
        type="button"
        className="pm-btn pm-btn--secondary pm-btn--xs"
        title="Coda delle attività"
        aria-expanded={panel}
        data-activities-toggle
        onClick={() => setPanel(!panel)}
      >
        <Ic icon={ListTodo} size={15} />
        <Ic icon={Clock} size={15} />
        Attività{queued ? ` · ${queued} in coda` : ''}
        {failed ? <span style={{ color: 'var(--danger)' }}> · {failed} fallite</span> : null}
      </button>
      {panel && <ActivitiesPanel onClose={() => setPanel(false)} />}
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
      <AnalysisToggle />
    </footer>
  );
}

const KIND: Record<string, string> = {
  summarize: 'sintesi',
  classify: 'classificazione',
  embed: 'indicizzazione per la ricerca',
  extract_tasks: 'task suggeriti',
  suggest_actions: 'azioni suggerite',
};

/**
 * Analisi in background (sintesi, classificazione, indicizzazione…): quanti lavori aspettano e un
 * pulsante per metterla in pausa, ad esempio durante il primo import di una casella grande.
 * L'assistente resta disponibile anche in pausa.
 */
function AnalysisToggle() {
  const qc = useQueryClient();
  const { data: st } = useQuery({ queryKey: ['jobs-status'], queryFn: api.jobsStatus, refetchInterval: 5000 });
  const toggle = useMutation({
    mutationFn: (aiPaused: boolean) => api.updateSettings({ aiPaused }),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      qc.invalidateQueries({ queryKey: ['jobs-status'] });
    },
  });
  if (!st || (!st.paused && st.pending === 0 && !st.running)) return null;
  const detail = Object.entries(st.byKind)
    .map(([k, n]) => `${n} ${KIND[k] ?? k}`)
    .join(', ');
  const count = st.pending.toLocaleString('it-IT');
  return (
    <button
      type="button"
      className={`pm-btn pm-btn--secondary pm-btn--xs pm-analysis${st.paused ? ' pm-analysis--paused' : ''}`}
      title={`${st.paused ? 'Analisi in pausa: clic per riprendere' : 'Analisi in corso: clic per metterla in pausa'}${detail ? ` · in coda: ${detail}` : ''}${st.running && !st.paused ? ` · ora: ${KIND[st.running] ?? st.running}` : ''}`}
      aria-pressed={st.paused}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!st.paused)}
    >
      <Ic icon={st.paused ? Play : Pause} size={14} />
      {st.paused ? `Analisi in pausa · ${count} in attesa` : `Analisi · ${count} in coda`}
    </button>
  );
}
