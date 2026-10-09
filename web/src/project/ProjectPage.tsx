import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Ellipsis, X } from 'lucide-react';
import type { ConversationQuery, ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useOpenMenu } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { Composer } from '../compose/Composer.tsx';
import { MessageView } from '../workspace/MessageView.tsx';
import type { ComposeRequest, PaneAction } from '../workspace/pane.ts';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS } from '../shell/paths.ts';
import { ConversationItem } from './ConversationItem.tsx';
import { Rail } from './Rail.tsx';
import { TasksSidebar } from './TasksSidebar.tsx';
import { RailEditor } from './RailEditor.tsx';
import { EditingDimmer, useEditing } from '../ui/editing.tsx';

const PAGE = 50;
const focusKey = (projectKey: string) => `mmw.focus.${projectKey}`;
const readFocus = (k: string) => {
  try {
    return localStorage.getItem(focusKey(k));
  } catch {
    return null;
  }
};
const writeFocus = (k: string, id: string | null) => {
  try {
    if (id) localStorage.setItem(focusKey(k), id);
    else localStorage.removeItem(focusKey(k));
  } catch {}
};

/** S1 · Progetto: barra contatti | conversazioni (una in focus) | barra dei task. */
export function ProjectPage({ projectKey, conversationId, messageId, onEditProject }: {
  projectKey: string;
  conversationId: string | null;
  messageId: string | null;
  onEditProject: (p: ProjectDto) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const openMenu = useOpenMenu();
  const isProject = projectKey !== SYSTEM_INBOX && projectKey !== SYSTEM_NEWS;
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const project = isProject ? projects.find((p) => p.id === projectKey) : undefined;
  const [archived, setArchived] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ request: ComposeRequest; key: number } | null>(null);
  const editing = useEditing();

  const query: ConversationQuery = useMemo(
    () => ({
      view: projectKey === SYSTEM_INBOX ? 'inbox' : projectKey === SYSTEM_NEWS ? 'noise' : 'project',
      projectId: isProject ? projectKey : undefined,
      person: person && person !== 'all' ? person : undefined,
      archived,
    }),
    [projectKey, isProject, person, archived],
  );
  const list = useInfiniteQuery({
    queryKey: ['conversations', query],
    queryFn: ({ pageParam }) => api.conversations({ ...query, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1]!.lastMessageAt),
  });
  const items = list.data?.pages.flat() ?? [];

  // Il focus si ricorda per progetto: tornando sulla tab si ritrova (§2.3, regola 1).
  useEffect(() => {
    if (conversationId) writeFocus(projectKey, conversationId);
    else if (!list.isLoading) {
      const remembered = readFocus(projectKey);
      if (remembered && items.some((c) => c.id === remembered)) navigate(paths.conversation(projectKey, remembered), { replace: true });
    }
  }, [conversationId, projectKey, list.isLoading, items, navigate]);

  const focus = (id: string) => navigate(paths.conversation(projectKey, id));
  const unfocus = () => {
    writeFocus(projectKey, null);
    navigate(paths.project(projectKey));
  };
  const total = isProject ? (project?.conversationCount ?? items.length) : projectKey === SYSTEM_INBOX ? (counts?.inbox ?? items.length) : (counts?.noise ?? items.length);

  const pane: PaneAction = useMemo(
    () => ({
      openMessage: (cid, mid) => navigate(paths.message(projectKey, cid, mid)),
      compose: (request) => setCompose({ request, key: Date.now() }),
      openNote: () => {},
      openTasks: () => {},
      close: () => setCompose(null),
    }),
    [navigate, projectKey],
  );

  const projectMenu = (el: HTMLElement) => {
    const refresh = () => {
      for (const k of [['conversations'], ['counts'], ['projects'], ['activities']]) qc.invalidateQueries({ queryKey: k });
    };
    const markRead = async () => {
      const res = isProject ? await api.markViewRead('project', projectKey) : await api.markViewRead(projectKey === SYSTEM_INBOX ? 'inbox' : 'noise');
      refresh();
      toast({
        text: res.count ? `${res.count} messaggi segnati come letti` : 'Niente da segnare come letto',
        action: res.count ? { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) } : undefined,
      });
    };
    openMenu(
      {
        title: project?.name ?? (projectKey === SYSTEM_INBOX ? 'Da smistare' : 'News'),
        actions: [
          { id: 'read', icon: 'mark_email_read', label: 'Segna tutto come letto', primary: true, run: markRead },
          ...(project ? [{ id: 'edit', icon: 'tune', label: 'Modifica progetto', primary: true, run: () => onEditProject(project) }] : []),
        ],
      },
      el,
      'bar',
    );
  };

  return (
    <div className="pm-project">
      {isProject && editing.mode === 'rail' && <RailEditor projectId={projectKey} onDone={() => editing.setMode(null)} />}
      {isProject && editing.mode !== 'rail' && (
        <Rail
          projectId={projectKey}
          onManage={() => editing.setMode('rail')}
          filter={person}
          onFilter={setPerson}
          onCompose={(to) => pane.compose({ to, projectId: projectKey })}
          onOpenPerson={(key) => navigate(`${paths.contacts()}?focus=${encodeURIComponent(key)}`)}
        />
      )}
      <div style={{ flex: '999 1 480px', minWidth: 0, display: 'flex', position: 'relative' }}>
      {editing.mode === 'rail' && <EditingDimmer />}
      <section className="pm-convlist" aria-label="Conversazioni">
        <div className="pm-subtabs">
          <button type="button" className="pm-subtab" aria-current={!archived ? 'true' : undefined} onClick={() => setArchived(false)}>
            Attive · {total}
          </button>
          <button type="button" className="pm-subtab" aria-current={archived ? 'true' : undefined} onClick={() => setArchived(true)}>
            Archiviate
          </button>
          {person && (
            <span className="pm-personchip pm-personchip--removable" style={{ paddingLeft: 10 }}>
              filtro per persona
              <button type="button" className="pm-personchip__remove" onClick={() => setPerson(null)} aria-label="Togli il filtro">
                <Ic icon={X} size={15} />
              </button>
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Opzioni del progetto" onClick={(e) => projectMenu(e.currentTarget)}>
            <Ic icon={Ellipsis} />
          </button>
        </div>
        <div className="pm-convstack">
          {list.isLoading && <div className="pm-empty">Caricamento…</div>}
          {!list.isLoading && items.length === 0 && (
            <div className="pm-empty">
              {archived ? 'Nessuna conversazione archiviata.' : projectKey === SYSTEM_INBOX ? 'Niente da smistare.' : 'Nessuna conversazione.'}
            </div>
          )}
          {items.map((c) => (
            <ConversationItem
              key={c.id}
              c={c}
              focused={c.id === conversationId}
              selectedMessageId={c.id === conversationId ? messageId : null}
              cb={{
                onFocus: () => focus(c.id),
                onUnfocus: unfocus,
                onOpenMessage: (mid) => pane.openMessage(c.id, mid),
                onCompose: pane.compose,
              }}
            />
          ))}
          {list.hasNextPage && (
            <button type="button" className="pm-btn pm-btn--secondary" style={{ alignSelf: 'center' }} onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? 'Caricamento…' : 'Carica altre'}
            </button>
          )}
        </div>
      </section>
      {isProject && <TasksSidebar projectId={projectKey} />}
      </div>

      {/* Provvisori fino al carosello (F4): lettura e scrittura in un pannello laterale. */}
      {messageId && conversationId && (
        <Sheet title="Messaggio" onClose={() => navigate(paths.conversation(projectKey, conversationId))}>
          <MessageView conversationId={conversationId} messageId={messageId} pane={pane} />
        </Sheet>
      )}
      {compose && (
        <Sheet title={compose.request.replyTo ? 'Risposta' : 'Nuova mail'} onClose={() => setCompose(null)}>
          <Composer
            key={compose.key}
            request={compose.request}
            ownEmails={accounts.map((a) => a.email.toLowerCase())}
            onClose={() => setCompose(null)}
            onSent={(cid) => isProject && focus(cid)}
          />
        </Sheet>
      )}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="pm-sheet-backdrop" onClick={onClose} />
      <div className="pm-sheet" role="dialog" aria-label={title}>
        <div className="pm-sheet__head">
          <span style={{ fontWeight: 600, flex: 1 }}>{title}</span>
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" onClick={onClose} aria-label="Chiudi">
            <Ic icon={X} />
          </button>
        </div>
        <div className="pm-sheet__body">{children}</div>
      </div>
    </>
  );
}
