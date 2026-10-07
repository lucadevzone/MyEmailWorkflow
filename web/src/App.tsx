import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProjectDto, SyncStatusDto } from '@mmw/shared';
import { api } from './api.ts';
import { useServerEvents } from './events.ts';
import { SettingsPage } from './settings/SettingsPage.tsx';
import { ConversationList } from './inbox/ConversationList.tsx';
import { ConversationView } from './inbox/ConversationView.tsx';
import { ActivitiesPage } from './activities/ActivitiesPage.tsx';
import { ProjectDialog } from './projects/ProjectDialog.tsx';
import { Composer } from './compose/Composer.tsx';
import { colorFor } from './lib/format.ts';
import { button, ghost } from './ui/styles.ts';

type Nav =
  | { kind: 'inbox' }
  | { kind: 'noise' }
  | { kind: 'project'; projectId: string }
  | { kind: 'activities' }
  | { kind: 'settings' };

// Le sezioni disattivate arrivano con le milestone successive (docs/02-system-design.md §9).
const UPCOMING = [
  { label: 'Persone', milestone: 'M3' },
  { label: 'Task', milestone: 'M4' },
];

export function App() {
  useServerEvents();
  const [nav, setNav] = useState<Nav>({ kind: 'inbox' });
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { project?: ProjectDto }>(null);
  const [composing, setComposing] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: activities } = useQuery({ queryKey: ['activities'], queryFn: api.activities });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const openActivities = activities?.activities.filter((a) => a.status === 'pending' || a.status === 'failed').length ?? 0;

  const go = (n: Nav) => {
    setNav(n);
    setSelected(null);
    setComposing(false);
  };
  const isActive = (n: Nav) =>
    nav.kind === n.kind && (n.kind !== 'project' || (nav.kind === 'project' && nav.projectId === n.projectId));

  const navButton = (n: Nav, label: React.ReactNode, badge?: number, color?: string) => (
    <button
      onClick={() => go(n)}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        isActive(n) ? 'bg-stone-200 font-medium dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-900'
      }`}
    >
      {/* Quadratino del colore del progetto: diverso dal pallino blu dei non letti. */}
      {color && <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? <span className="text-xs tabular-nums text-stone-500">{badge}</span> : null}
    </button>
  );

  const visibleProjects = projects.filter((p) => showArchivedProjects || !p.archived);
  const project = nav.kind === 'project' ? projects.find((p) => p.id === nav.projectId) : undefined;
  const outgoing = project && accounts.find((a) => a.id === project.outgoingAccountId);

  return (
    <div className="flex h-full">
      <nav className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-stone-200 p-3 dark:border-stone-800">
        <div className="mb-4 px-2 text-sm font-semibold tracking-tight">my mail workflow</div>
        {navButton({ kind: 'inbox' }, 'Da smistare', counts?.inboxUnread)}
        {navButton({ kind: 'activities' }, 'Attività', openActivities)}

        <div className="mt-4 flex items-center justify-between px-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Progetti</span>
          <button className="text-lg leading-none text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" title="Nuovo progetto" onClick={() => setDialog({})}>
            +
          </button>
        </div>
        {visibleProjects.length === 0 && <p className="px-2 text-xs text-stone-500">Nessun progetto: crea il primo con +</p>}
        {visibleProjects.map((p) =>
          navButton(
            { kind: 'project', projectId: p.id },
            <span className={p.archived ? 'text-stone-400' : ''}>{p.name}</span>,
            p.unreadCount,
            p.color ?? colorFor(p.id),
          ),
        )}
        {projects.some((p) => p.archived) && (
          <button className="px-2 text-left text-xs text-stone-500 underline" onClick={() => setShowArchivedProjects(!showArchivedProjects)}>
            {showArchivedProjects ? 'Nascondi archiviati' : 'Mostra archiviati'}
          </button>
        )}

        <div className="mt-4 space-y-1">
          {UPCOMING.map((s) => (
            <button
              key={s.label}
              disabled
              title={`Disponibile da ${s.milestone}`}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-stone-400 dark:text-stone-600"
            >
              {s.label}
              <span className="text-[10px] uppercase">{s.milestone}</span>
            </button>
          ))}
        </div>
        <div className="my-2 border-t border-stone-200 dark:border-stone-800" />
        {navButton({ kind: 'noise' }, 'Rumore', counts?.noise)}
        <div className="flex-1" />
        <SyncIndicator />
        {navButton({ kind: 'settings' }, 'Impostazioni')}
      </nav>

      {nav.kind === 'settings' && (
        <main className="min-w-0 flex-1 overflow-y-auto">
          <SettingsPage />
        </main>
      )}
      {nav.kind === 'activities' && (
        <main className="min-w-0 flex-1 overflow-y-auto">
          <ActivitiesPage />
        </main>
      )}
      {(nav.kind === 'inbox' || nav.kind === 'noise' || nav.kind === 'project') && (
        <>
          <section className="w-96 shrink-0 border-r border-stone-200 dark:border-stone-800">
            {nav.kind === 'project' ? (
              <ConversationList
                key={nav.projectId}
                query={{ view: 'project', projectId: nav.projectId }}
                title={project?.name ?? '…'}
                subtitle={
                  <>
                    {project?.description && <span className="block">{project.description}</span>}
                    {outgoing && <span>Invia da {outgoing.email}</span>}
                  </>
                }
                actions={
                  <div className="flex shrink-0 gap-1">
                    <button className={ghost} onClick={() => project && setDialog({ project })} title="Modifica progetto">
                      ⚙︎
                    </button>
                    <button
                      className={button}
                      onClick={() => {
                        setSelected(null);
                        setComposing(true);
                      }}
                    >
                      Nuova email
                    </button>
                  </div>
                }
                emptyText="Nessuna conversazione in questo progetto."
                selectedId={selected}
                onSelect={(id) => {
                  setComposing(false);
                  setSelected(id);
                }}
              />
            ) : (
              <ConversationList
                key={nav.kind}
                query={{ view: nav.kind }}
                title={nav.kind === 'inbox' ? 'Da smistare' : 'Rumore'}
                subtitle={nav.kind === 'inbox' ? 'Conversazioni non ancora assegnate a un progetto' : 'Newsletter e notifiche automatiche'}
                emptyText={nav.kind === 'inbox' ? 'Niente da smistare.' : 'Nessuna conversazione marcata come rumore.'}
                selectedId={selected}
                onSelect={setSelected}
              />
            )}
          </section>
          <main className="min-w-0 flex-1">
            {composing && nav.kind === 'project' ? (
              <div className="h-full overflow-y-auto bg-stone-100/60 p-4 dark:bg-stone-950">
                <h2 className="mb-3 text-lg font-semibold">Nuova email</h2>
                <Composer
                  projectId={nav.projectId}
                  ownEmails={accounts.map((a) => a.email.toLowerCase())}
                  onClose={() => setComposing(false)}
                  onSent={(conversationId) => setSelected(conversationId)}
                />
              </div>
            ) : selected ? (
              <ConversationView id={selected} onClose={() => setSelected(null)} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-stone-400">Seleziona una conversazione</div>
            )}
          </main>
        </>
      )}

      {dialog && (
        <ProjectDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onSaved={(p) => !dialog.project && go({ kind: 'project', projectId: p.id })}
        />
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
