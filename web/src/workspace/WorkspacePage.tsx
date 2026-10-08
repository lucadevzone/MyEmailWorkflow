import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ConversationQuery } from '@mmw/shared';
import { api } from '../api.ts';
import { Composer } from '../compose/Composer.tsx';
import { Split } from '../ui/Split.tsx';
import { Icon } from '../ui/Icon.tsx';
import { ConversationCard } from './ConversationCard.tsx';
import { MessageView } from './MessageView.tsx';
import { NoteEditor } from './NoteEditor.tsx';
import { PeopleRail } from './PeopleRail.tsx';
import type { PaneAction, PaneState } from './pane.ts';
import { TasksPanel, TaskRow } from '../tasks/TasksPanel.tsx';
import { useQuery as useQ } from '@tanstack/react-query';

const PAGE = 50;

export type WorkspaceScope = { view: 'inbox' } | { view: 'noise' } | { view: 'project'; projectId: string };

/** Pagina di una voce della barra superiore: persone | conversazioni | messaggio. */
export function WorkspacePage({ scope, focusConversationId, onEditProject }: {
  scope: WorkspaceScope;
  /** Conversazione da espandere all'apertura (es. arrivando dalla pagina Contatti). */
  focusConversationId?: string | null;
  onEditProject: () => void;
}) {
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const project = scope.view === 'project' ? projects.find((p) => p.id === scope.projectId) : undefined;
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(focusConversationId ?? null);
  const [pane, setPane] = useState<PaneState>({ kind: 'empty' });

  const query: ConversationQuery = useMemo(
    () => ({ view: scope.view, projectId: scope.view === 'project' ? scope.projectId : undefined, archived }),
    [scope, archived],
  );
  const list = useInfiniteQuery({
    queryKey: ['conversations', query],
    queryFn: ({ pageParam }) => api.conversations({ ...query, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1]!.lastMessageAt),
  });
  const items = list.data?.pages.flat() ?? [];

  // Una conversazione da mettere a fuoco può essere archiviata: in quel caso la si cerca lì.
  const { data: focusDetail } = useQuery({
    queryKey: ['conversation', focusConversationId],
    queryFn: () => api.conversation(focusConversationId!),
    enabled: !!focusConversationId,
  });
  useEffect(() => {
    if (focusDetail?.archived) setArchived(true);
  }, [focusDetail]);

  const openMessage = useCallback((conversationId: string, messageId: string) => setPane({ kind: 'message', conversationId, messageId }), []);
  const actions: PaneAction = useMemo(
    () => ({
      openMessage,
      compose: (request) => setPane({ kind: 'compose', request, key: Date.now() }),
      openNote: (conversationId, noteId) => setPane({ kind: 'note', conversationId, noteId, key: Date.now() }),
      openTasks: (projectId) => setPane({ kind: 'tasks', projectId }),
      close: () => setPane({ kind: 'empty' }),
    }),
    [openMessage],
  );

  const title = scope.view === 'inbox' ? 'Da smistare' : scope.view === 'noise' ? 'Rumore' : (project?.name ?? '…');
  const outgoing = project && accounts.find((a) => a.id === project.outgoingAccountId);

  const left = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-2 text-xs dark:border-stone-800">
        <button className={!archived ? 'font-semibold' : 'text-stone-500'} onClick={() => setArchived(false)}>
          Attive
        </button>
        <button className={archived ? 'font-semibold' : 'text-stone-500'} onClick={() => setArchived(true)}>
          Archiviate
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading && <div className="p-4 text-sm text-stone-500">Caricamento…</div>}
        {!list.isLoading && items.length === 0 && (
          <div className="p-4 text-sm text-stone-500">{archived ? 'Nessuna conversazione archiviata.' : 'Nessuna conversazione.'}</div>
        )}
        <ul>
          {items.map((c) => (
            <ConversationCard
              key={c.id}
              c={c}
              expanded={selected === c.id}
              selectedMessageId={pane.kind === 'message' && pane.conversationId === c.id ? pane.messageId : null}
              onToggle={() => setSelected(selected === c.id ? null : c.id)}
              pane={actions}
            />
          ))}
        </ul>
        {list.hasNextPage && (
          <button className="w-full p-3 text-sm text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-900" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? 'Caricamento…' : 'Carica altre'}
          </button>
        )}
      </div>
    </div>
  );

  const right = (
    <div className="h-full overflow-y-auto bg-white dark:bg-stone-900">
      {pane.kind === 'empty' && <div className="flex h-full items-center justify-center text-sm text-stone-400">Seleziona una conversazione</div>}
      {pane.kind === 'message' && <MessageView conversationId={pane.conversationId} messageId={pane.messageId} pane={actions} />}
      {pane.kind === 'compose' && (
        <Composer
          key={pane.key}
          request={pane.request}
          ownEmails={accounts.map((a) => a.email.toLowerCase())}
          onClose={actions.close}
          onSent={(conversationId) => setSelected(conversationId)}
        />
      )}
      {pane.kind === 'note' && <NoteEditor key={pane.key} conversationId={pane.conversationId} noteId={pane.noteId} pane={actions} />}
      {pane.kind === 'tasks' && (
        <TasksPanel
          projectId={pane.projectId}
          onOpenConversation={(conversationId, messageId) => {
            setSelected(conversationId);
            if (messageId) openMessage(conversationId, messageId);
          }}
        />
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-stone-200 bg-stone-50 px-5 py-3 dark:border-stone-800 dark:bg-stone-950">
        <div className="min-w-0 shrink-0">
          <h1 className="truncate text-xl font-semibold">{title}</h1>
          {project && (
            <p className="max-w-80 truncate text-xs text-stone-500">
              {project.description ? `${project.description} · ` : ''}
              {outgoing ? `invia da ${outgoing.email}` : ''}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {project && <ProjectTaskChips projectId={project.id} onOpen={() => actions.openTasks(project.id)} />}
        </div>
        {project && (
          <>
            <button
              className={`flex size-8 items-center justify-center rounded-md ${pane.kind === 'tasks' ? 'bg-stone-200 text-stone-900 dark:bg-stone-800 dark:text-stone-100' : 'text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800'}`}
              title="Task del progetto"
              onClick={() => (pane.kind === 'tasks' ? actions.close() : actions.openTasks(project.id))}
            >
              <Icon name="checklist" />
            </button>
            <button className="flex size-8 items-center justify-center rounded-md text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800" title="Modifica progetto" onClick={onEditProject}>
              <Icon name="tune" />
            </button>
            <button
              className="flex items-center gap-1 rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900"
              onClick={() => actions.compose({ projectId: project.id })}
            >
              <Icon name="edit" size={18} /> Nuova email
            </button>
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {scope.view === 'project' && <PeopleRail projectId={scope.projectId} onCompose={(to) => actions.compose({ to, projectId: scope.projectId })} />}
        <Split storageKey="mmw.split.workspace" left={left} right={right} />
      </div>
    </div>
  );
}

const CHIPS = 3;

/** Primi task aperti del progetto nella barra del titolo; clic = pannello completo. */
function ProjectTaskChips({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { data: tasks = [] } = useQ({ queryKey: ['tasks', 'project', projectId], queryFn: () => api.projectTasks(projectId) });
  const open = tasks.filter((t) => t.status === 'open');
  if (!open.length) return null;
  return (
    <>
      {open.slice(0, CHIPS).map((t) => (
        <div key={t.id} className="min-w-0 max-w-64 shrink rounded-full border border-stone-200 bg-white pr-1 dark:border-stone-700 dark:bg-stone-900">
          <TaskRow t={t} compact />
        </div>
      ))}
      {open.length > CHIPS && (
        <button className="shrink-0 text-xs text-stone-500 hover:underline" onClick={onOpen}>
          +{open.length - CHIPS}
        </button>
      )}
    </>
  );
}
