import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bookmark, Ellipsis, MailCheck, Send, Signature, X } from 'lucide-react';
import type { ConversationQuery, ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useOpenMenu } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import type { PaneAction } from '../workspace/pane.ts';
import { MailView } from '../mail/MailView.tsx';
import { composeTarget, seedOf } from '../mail/seed.ts';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS, SYSTEM_SPAM } from '../shell/paths.ts';
import { ConversationItem } from './ConversationItem.tsx';
import { TasksSidebar } from './TasksSidebar.tsx';
import { NewMailMenu } from './NewMailMenu.tsx';

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
const TASKS_KEY = 'mmw.tasks.open';
const readTasksOpen = () => {
  try {
    return localStorage.getItem(TASKS_KEY) === '1';
  } catch {
    return false;
  }
};

/** S1 · Progetto: intestazione (viste, invio, Nuova mail, Task) | conversazioni (una in focus) | pannello dei task a comparsa. */
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
  const isProject = projectKey !== SYSTEM_INBOX && projectKey !== SYSTEM_NEWS && projectKey !== SYSTEM_SPAM;
  const { data: projects = [], isSuccess: projectsLoaded } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const project = isProject ? projects.find((p) => p.id === projectKey) : undefined;
  const [view, setView] = useState<'active' | 'important' | 'archived'>('active');
  const archived = view === 'archived';
  // Filtro per persona: arriva dalla ricerca (?person=…), si toglie dal chip.
  // Lo si tiene nello stato della pagina, così resta aprendo le conversazioni.
  const [params, setParams] = useSearchParams();
  const [person, setPerson] = useState<{ key: string; name: string } | null>(null);
  useEffect(() => {
    const key = params.get('person');
    if (!key) return;
    setPerson({ key, name: params.get('name') || 'persona' });
    setView('active');
    params.delete('person');
    params.delete('name');
    setParams(params, { replace: true });
  }, [params, setParams]);
  const clearPerson = () => setPerson(null);
  const { data: important = {} } = useQuery({ queryKey: ['important-counts'], queryFn: api.importantCounts });
  const [tasksOpen, setTasksOpenState] = useState(readTasksOpen);
  const setTasksOpen = (v: boolean) => {
    setTasksOpenState(v);
    try {
      localStorage.setItem(TASKS_KEY, v ? '1' : '0');
    } catch {}
  };
  const openMenu = useOpenMenu();

  const query: ConversationQuery = useMemo(
    () => ({
      view: projectKey === SYSTEM_INBOX ? 'inbox' : projectKey === SYSTEM_NEWS ? 'noise' : projectKey === SYSTEM_SPAM ? 'spam' : 'project',
      projectId: isProject ? projectKey : undefined,
      person: person?.key,
      archived,
      important: view === 'important',
    }),
    [projectKey, isProject, person, archived, view],
  );
  const list = useInfiniteQuery({
    queryKey: ['conversations', query],
    queryFn: ({ pageParam }) => api.conversations({ ...query, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1]!.sortAt),
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
  const total = isProject
    ? (project?.conversationCount ?? items.length)
    : projectKey === SYSTEM_INBOX
      ? (counts?.inbox ?? items.length)
      : projectKey === SYSTEM_SPAM
        ? (counts?.spam ?? items.length)
        : (counts?.noise ?? items.length);

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
    if (projectKey === SYSTEM_SPAM) return;
    const res = isProject ? await api.markViewRead('project', projectKey) : await api.markViewRead(projectKey === SYSTEM_INBOX ? 'inbox' : 'noise');
    refresh();
    toast({
      text: res.count ? `${res.count} messaggi segnati come letti` : 'Niente da segnare come letto',
      action: res.count ? { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) } : undefined,
    });
  };
  const outgoing = project ? accounts.find((a) => a.id === project.outgoingAccountId) : undefined;
  const { data: signatures = [] } = useQuery({ queryKey: ['signatures'], queryFn: api.signatures, enabled: !!project });
  const signature = project?.signatureId ? signatures.find((s) => s.id === project.signatureId) : undefined;

  // S2/S3: il carosello prende il posto della lista; la conversazione resta in focus al ritorno.
  if (messageId || draftId) {
    return <MailView key={conversationId ?? 'new-mail'} projectKey={projectKey} conversationId={conversationId} messageId={messageId} draftId={draftId} />;
  }

  const unread = isProject ? (project?.unreadCount ?? 0) : projectKey === SYSTEM_INBOX ? (counts?.inboxUnread ?? 0) : projectKey === SYSTEM_NEWS ? (counts?.noiseUnread ?? 0) : 0;
  const importantCount = important[projectKey] ?? 0;
  const openTasks = project?.openTaskCount ?? 0;
  const late = !!project?.overdueTaskCount;

  return (
    <div className="pm-project">
      <h1 className="pm-sr-only">{project?.name ?? (projectKey === SYSTEM_INBOX ? 'Da smistare' : projectKey === SYSTEM_SPAM ? 'Spam' : 'News')}</h1>
      <div className="pm-project__main">
      <section className="pm-convlist" aria-label="Conversazioni">
        <div className="pm-projheader">
          <div className="pm-projheader__left">
            <span className="pm-seg pm-views" role="radiogroup" aria-label="Vista">
              <button type="button" role="radio" className="pm-seg__opt" aria-checked={view === 'active'} title={`${total} conversazioni attive`} onClick={() => setView('active')}>
                Attive {unread > 0 && <span className="pm-badge">{unread > 99 ? '99+' : unread}</span>}
              </button>
              <button type="button" role="radio" className="pm-seg__opt" aria-checked={view === 'important'} onClick={() => setView('important')}>
                <Ic icon={Bookmark} size={14} className="pm-views__mark" /> Importanti {importantCount > 0 && <span className="pm-views__count">{importantCount}</span>}
              </button>
              <button type="button" role="radio" className="pm-seg__opt" aria-checked={view === 'archived'} onClick={() => setView('archived')}>
                Archiviate
              </button>
            </span>
            {person && (
              <span className="pm-personchip pm-personchip--removable" style={{ paddingLeft: 10 }}>
                <span className="pm-truncate">con {person.name}</span>
                <button type="button" className="pm-personchip__remove" onClick={clearPerson} aria-label="Togli il filtro per persona">
                  <Ic icon={X} size={15} />
                </button>
              </span>
            )}
          </div>
          {/* Account di uscita e firma del progetto: tutte le mail nuove e le risposte partono da qui. */}
          {project && (
            <span className="pm-sendinfo">
              <span className="pm-sendinfo__item" title="Account di uscita del progetto">
                <Ic icon={Send} size={15} />
                {outgoing ? <span className="pm-truncate">{outgoing.email}</span> : 'Account di uscita non trovato'}
              </span>
              <span aria-hidden="true">·</span>
              <button type="button" className="pm-sendinfo__item pm-sendinfo__sig" title={signature ? `Firma: ${signature.text}` : 'Nessuna firma: sceglila nelle impostazioni del progetto'} onClick={() => onEditProject(project)}>
                <Ic icon={Signature} size={15} />
                <span className="pm-truncate">{signature ? `Firma: ${signature.label}` : 'Nessuna firma'}</span>
              </button>
            </span>
          )}
          <div className="pm-projheader__right">
            {project && <NewMailMenu projectId={projectKey} onCompose={(to) => pane.compose({ to, projectId: projectKey })} />}
            {projectKey !== SYSTEM_SPAM && (
              <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Segna tutto come letto" title="Segna tutto come letto" onClick={() => void markAllRead()}>
                <Ic icon={MailCheck} />
              </button>
            )}
            {project && (
              <button
                type="button"
                className="pm-iconbtn pm-iconbtn--sm"
                aria-label="Altre azioni del progetto"
                title="Altre azioni"
                onClick={(e) =>
                  openMenu(
                    {
                      title: project.name,
                      actions: [{ id: 'settings', icon: 'tune', label: 'Impostazioni del progetto', primary: true, run: () => onEditProject(project) }],
                    },
                    e.currentTarget,
                  )
                }
              >
                <Ic icon={Ellipsis} />
              </button>
            )}
            {project && (
              <button
                type="button"
                className={`pm-taskbtn${openTasks ? ' pm-taskbtn--has' : ''}${late ? ' pm-taskbtn--late' : ''}`}
                aria-pressed={tasksOpen}
                aria-label={`Task del progetto: ${openTasks} aperti${late ? `, ${project.overdueTaskCount} scaduti` : ''}`}
                title="Task del progetto"
                onClick={() => setTasksOpen(!tasksOpen)}
              >
                <Icon name={late ? 'assignment_late' : 'assignment'} size={18} />
                {openTasks > 0 && <span>{openTasks}</span>}
              </button>
            )}
          </div>
        </div>
        <div className="pm-convstack">
          {/* Account collegato ma ancora nessun progetto: lo smistamento non ha dove proporre. */}
          {projectKey === SYSTEM_INBOX && !archived && projectsLoaded && !projects.some((p) => !p.archived) && (
            <div className="pm-welcomehint">
              <span>Crea i tuoi progetti: l'analizzatore potrà proporre subito dove smistare la posta.</span>
              <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => navigate('/welcome?step=2')}>
                Procedura guidata
              </button>
            </div>
          )}
          {list.isLoading && <div className="pm-empty">Caricamento…</div>}
          {!list.isLoading && items.length === 0 && (
            <div className="pm-empty">
              {view === 'important'
                ? 'Nessuna conversazione importante: segna un messaggio con il segnalibro.'
                : archived
                  ? 'Nessuna conversazione archiviata.'
                  : projectKey === SYSTEM_INBOX
                    ? 'Niente da smistare.'
                    : 'Nessuna conversazione.'}
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
      {isProject && tasksOpen && <TasksSidebar projectId={projectKey} onClose={() => setTasksOpen(false)} />}
      </div>

    </div>
  );
}
