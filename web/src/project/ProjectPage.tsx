import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MailCheck, Send, Settings2, X } from 'lucide-react';
import type { ConversationQuery, ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useToast } from '../ui/toast.tsx';
import type { PaneAction } from '../workspace/pane.ts';
import { MailView } from '../mail/MailView.tsx';
import { composeTarget, seedOf } from '../mail/seed.ts';
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
export function ProjectPage({ projectKey, conversationId, messageId, draftId, onEditProject }: {
  projectKey: string;
  conversationId: string | null;
  messageId: string | null;
  draftId: string | null;
  onEditProject: (p: ProjectDto) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const isProject = projectKey !== SYSTEM_INBOX && projectKey !== SYSTEM_NEWS;
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const project = isProject ? projects.find((p) => p.id === projectKey) : undefined;
  const [archived, setArchived] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
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
    else if (!list.isLoading && !draftId) {
      const remembered = readFocus(projectKey);
      if (remembered && items.some((c) => c.id === remembered)) navigate(paths.conversation(projectKey, remembered), { replace: true });
    }
  }, [conversationId, draftId, projectKey, list.isLoading, items, navigate]);

  // Arrivando da un link (ricerca, contatti, task) la conversazione in focus può stare più in basso:
  // si caricano altre pagine finché non compare, poi la si porta in vista.
  const found = !!conversationId && items.some((c) => c.id === conversationId);
  const pagesLoaded = list.data?.pages.length ?? 0;
  useEffect(() => {
    if (conversationId && !found && !list.isLoading && list.hasNextPage && !list.isFetchingNextPage && pagesLoaded < 20) void list.fetchNextPage();
  }, [conversationId, found, list.isLoading, list.hasNextPage, list.isFetchingNextPage, pagesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationId || !found || scrolledTo.current === conversationId) return;
    scrolledTo.current = conversationId;
    const el = document.querySelector(`[data-conversation="${CSS.escape(conversationId)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [conversationId, found]);

  const focus = (id: string) => navigate(paths.conversation(projectKey, id));
  const unfocus = () => {
    writeFocus(projectKey, null);
    navigate(paths.project(projectKey));
  };
  const total = isProject ? (project?.conversationCount ?? items.length) : projectKey === SYSTEM_INBOX ? (counts?.inbox ?? items.length) : (counts?.noise ?? items.length);

  const pane: PaneAction = useMemo(
    () => ({
      openMessage: (cid, mid) => navigate(paths.message(projectKey, cid, mid)),
      compose: (request) => navigate(composeTarget(projectKey, request), { state: { seed: seedOf(request) } }),
      openNote: () => {},
      openTasks: () => {},
      close: () => {},
    }),
    [navigate, projectKey],
  );

  const markAllRead = async () => {
    const refresh = () => {
      for (const k of [['conversations'], ['counts'], ['projects'], ['activities']]) qc.invalidateQueries({ queryKey: k });
    };
    const res = isProject ? await api.markViewRead('project', projectKey) : await api.markViewRead(projectKey === SYSTEM_INBOX ? 'inbox' : 'noise');
    refresh();
    toast({
      text: res.count ? `${res.count} messaggi segnati come letti` : 'Niente da segnare come letto',
      action: res.count ? { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) } : undefined,
    });
  };
  const outgoing = project ? accounts.find((a) => a.id === project.outgoingAccountId) : undefined;

  // S2/S3: il carosello prende il posto della lista; la conversazione resta in focus al ritorno.
  if (messageId || draftId) {
    return <MailView key={conversationId ?? 'new-mail'} projectKey={projectKey} conversationId={conversationId} messageId={messageId} draftId={draftId} />;
  }

  return (
    <div className="pm-project">
      <h1 className="pm-sr-only">{project?.name ?? (projectKey === SYSTEM_INBOX ? 'Da smistare' : 'News')}</h1>
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
      <div className="pm-project__main">
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
          {/* Account di uscita del progetto: tutte le mail nuove e le risposte partono da qui. */}
          <span className="pm-subtabs__account" title="Account di uscita del progetto">
            {project && (
              <>
                <Ic icon={Send} size={15} />
                {outgoing ? (
                  <>
                    Esce da <strong>{outgoing.name}</strong> <span className="pm-truncate">{outgoing.email}</span>
                  </>
                ) : (
                  'Account di uscita non trovato'
                )}
              </>
            )}
          </span>
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Segna tutto come letto" title="Segna tutto come letto" onClick={() => void markAllRead()}>
            <Ic icon={MailCheck} />
          </button>
          {project && (
            <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Impostazioni del progetto" title="Impostazioni del progetto" onClick={() => onEditProject(project)}>
              <Ic icon={Settings2} />
            </button>
          )}
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
                onCompose: (r) => pane.compose({ conversationId: r.replyTo ? c.id : null, ...r }),
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

    </div>
  );
}
