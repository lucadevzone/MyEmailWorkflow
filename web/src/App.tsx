import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConversationView as View, SyncStatusDto } from '@mmw/shared';
import { api } from './api.ts';
import { useServerEvents } from './events.ts';
import { SettingsPage } from './settings/SettingsPage.tsx';
import { ConversationList } from './inbox/ConversationList.tsx';
import { ConversationView } from './inbox/ConversationView.tsx';

type Section = View | 'settings';

// Le sezioni disattivate arrivano con le milestone successive (docs/02-system-design.md §9).
const UPCOMING = [
  { label: 'Progetti', milestone: 'M2' },
  { label: 'Persone', milestone: 'M3' },
  { label: 'Task', milestone: 'M4' },
  { label: 'Attività', milestone: 'M2' },
];

export function App() {
  useServerEvents();
  const [section, setSection] = useState<Section>('inbox');
  const [selected, setSelected] = useState<string | null>(null);
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });

  const go = (s: Section) => {
    setSection(s);
    setSelected(null);
  };

  const navItem = (s: Section, label: string, badge?: number) => (
    <button
      onClick={() => go(s)}
      className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
        section === s ? 'bg-stone-200 font-medium dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-900'
      }`}
    >
      {label}
      {badge ? <span className="text-xs tabular-nums text-stone-500">{badge}</span> : null}
    </button>
  );

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-stone-200 p-3 dark:border-stone-800">
        <div className="mb-4 px-2 text-sm font-semibold tracking-tight">my mail workflow</div>
        {navItem('inbox', 'Da smistare', counts?.inboxUnread)}
        {UPCOMING.map((s) => (
          <button
            key={s.label}
            disabled
            title={`Disponibile da ${s.milestone}`}
            className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-stone-400 dark:text-stone-600"
          >
            {s.label}
            <span className="text-[10px] uppercase">{s.milestone}</span>
          </button>
        ))}
        <div className="my-2 border-t border-stone-200 dark:border-stone-800" />
        {navItem('noise', 'Rumore', counts?.noise)}
        <div className="flex-1" />
        <SyncIndicator />
        {navItem('settings', 'Impostazioni')}
      </nav>

      {section === 'settings' ? (
        <main className="min-w-0 flex-1 overflow-y-auto">
          <SettingsPage />
        </main>
      ) : (
        <>
          <section className="w-96 shrink-0 border-r border-stone-200 dark:border-stone-800">
            <ConversationList view={section} selectedId={selected} onSelect={setSelected} />
          </section>
          <main className="min-w-0 flex-1">
            {selected ? (
              <ConversationView id={selected} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-stone-400">
                Seleziona una conversazione
              </div>
            )}
          </main>
        </>
      )}
    </div>
  );
}

const PHASE_LABEL: Record<SyncStatusDto['phase'], string> = {
  stopped: 'Fermo',
  connecting: 'Connessione…',
  initial: 'Importazione posta recente…',
  backfill: 'Importazione storico…',
  idle: 'Aggiornato',
  error: 'Errore',
};

function SyncIndicator() {
  const { data: statuses = [] } = useQuery({ queryKey: ['sync'], queryFn: api.syncStatus });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  if (!statuses.length) return null;
  return (
    <div className="mb-2 space-y-1 px-2 text-xs text-stone-500">
      {statuses.map((s) => {
        const name = accounts.find((a) => a.id === s.accountId)?.name ?? 'Account';
        const busy = s.phase === 'initial' || s.phase === 'backfill' || s.phase === 'connecting';
        return (
          <div key={s.accountId} title={s.error ?? undefined}>
            <div className="flex items-center gap-1.5">
              <span
                className={`size-1.5 rounded-full ${
                  s.phase === 'error' ? 'bg-rose-500' : busy ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'
                }`}
              />
              <span className="truncate">
                {name}: {PHASE_LABEL[s.phase]}
              </span>
            </div>
            {s.phase === 'error' && s.error && <div className="truncate pl-3 text-rose-600">{s.error}</div>}
            {s.imported > 0 && busy && <div className="pl-3">{s.imported} messaggi importati</div>}
          </div>
        );
      })}
    </div>
  );
}
