import { useQuery } from '@tanstack/react-query';
import type { SyncStatusDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Badge } from '../ui/Badge.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useSyncStatuses } from '../events.ts';
import type { Nav } from './nav.ts';

const PHASE: Record<SyncStatusDto['phase'], string> = {
  stopped: 'fermo',
  connecting: 'connessione…',
  initial: 'importazione posta recente…',
  backfill: 'importazione storico…',
  idle: 'aggiornato',
  error: 'errore',
};

function Dot({ online }: { online: boolean }) {
  return <span className={`inline-block size-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-orange-500'}`} />;
}

/** Barra di stato: impostazioni, contatti, attività | stato account e Ollama. */
export function StatusBar({ nav, onNav }: { nav: Nav; onNav: (n: Nav) => void }) {
  const statuses = useSyncStatuses();
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const { data: activities } = useQuery({ queryKey: ['activities'], queryFn: api.activities });
  const open = activities?.activities.filter((a) => a.status === 'pending' || a.status === 'failed').length ?? 0;

  const iconButton = (n: Nav, icon: string, title: string, badge?: number) => (
    <button
      onClick={() => onNav(n)}
      title={title}
      className={`relative flex size-8 items-center justify-center rounded-md ${
        nav.kind === n.kind ? 'bg-stone-200 text-stone-900 dark:bg-stone-700 dark:text-stone-100' : 'text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100'
      }`}
    >
      <Icon name={icon} />
      {!!badge && (
        <span className="absolute -right-1 -top-1">
          <Badge n={badge} tone="sky" />
        </span>
      )}
    </button>
  );

  const ollamaOk = !!health?.ollama.ok && !!health.config.llmAvailable;

  return (
    <footer className="flex h-10 shrink-0 items-center gap-1 border-t border-stone-200 bg-white px-2 dark:border-stone-800 dark:bg-stone-900">
      {iconButton({ kind: 'settings' }, 'settings', 'Impostazioni')}
      {iconButton({ kind: 'people' }, 'person', 'Contatti')}
      {iconButton({ kind: 'activities' }, 'assignment', 'Attività', open)}
      <div className="flex-1" />
      <div className="flex items-center gap-4 pr-2 text-xs text-stone-500">
        {accounts.map((a) => {
          const s = statuses.find((x) => x.accountId === a.id);
          const online = !!s && s.phase !== 'error' && s.phase !== 'stopped' && s.phase !== 'connecting';
          return (
            <span key={a.id} className="flex items-center gap-1.5" title={s?.error ?? `${a.email}: ${s ? PHASE[s.phase] : 'non avviato'}`}>
              <Dot online={online} />
              {a.name}
              {s && (s.phase === 'initial' || s.phase === 'backfill') && <span className="text-stone-400">· {PHASE[s.phase]}</span>}
            </span>
          );
        })}
        <span
          className="flex items-center gap-1.5"
          title={health ? (ollamaOk ? `${health.config.llmModel} su ${health.ollama.url}` : health.ollama.error ?? `Modello ${health.config.llmModel} non disponibile`) : 'Controllo…'}
        >
          <Dot online={ollamaOk} />
          Ollama
        </span>
      </div>
    </footer>
  );
}
