import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bookmark, Ellipsis, MailCheck, Send, Signature, X } from 'lucide-react';
import type { ConversationListItem, ConversationQuery, ProjectDto } from '@mmw/shared';
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
import { BulkBar } from './BulkBar.tsx';
import { readOpenGroups, writeOpenGroups } from './dateGroups.ts';
import { DateGroupSection, GroupHead } from './DateGroupSection.tsx';
import { dateGroupOf } from '@mmw/shared';

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
/** Posizione nella lista per progetto e vista: aprendo una mail la lista lascia il posto alla vista Email. */
const savedScroll = new Map<string, number>();
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
  // "Da leggere" (tutte, di qualunque data) e il resto a pagine, raggruppato per data.
  const unreadList = useQuery({
    queryKey: ['conversations', query, 'unread'],
    queryFn: () => api.conversations({ ...query, unread: 'only', limit: 200 }),
  });
  // Il resto, per gruppi di data: si chiedono solo le intestazioni con i conteggi; ogni gruppo carica le
  // sue conversazioni quando lo si apre.
  const groupsQuery = useQuery({
    queryKey: ['conversations', query, 'groups'],
    queryFn: () => api.dateGroups({ ...query, unread: 'exclude' }),
  });
  const dateGroups = groupsQuery.data ?? [];
  const [groupItems, setGroupItems] = useState<Record<string, ConversationListItem[]>>({});
  const onGroupItems = useCallback((key: string, list: ConversationListItem[]) => {
    setGroupItems((cur) => (cur[key] === list || (!cur[key]?.length && !list.length) ? cur : { ...cur, [key]: list }));
  }, []);
  useEffect(() => setGroupItems({}), [query]);
  const unreadItems = unreadList.data ?? [];

  // La conversazione aperta mentre era da leggere resta in "Da leggere" finché è aperta: se saltasse nel
  // suo gruppo per data, la lista si muoverebbe sotto il mouse mentre la si legge.
  const [stickyId, setStickyId] = useState<string | null>(null);
  useEffect(() => {
    if (conversationId && unreadItems.some((c) => c.id === conversationId)) setStickyId(conversationId);
    else if (conversationId !== stickyId) setStickyId(null);
  }, [conversationId, unreadItems]); // eslint-disable-line react-hooks/exhaustive-deps
  const stickyItemQuery = useQuery({
    queryKey: ['conversation-item', stickyId],
    queryFn: () => api.conversationItem(stickyId!),
    enabled: !!stickyId && !unreadItems.some((c) => c.id === stickyId),
  });
  // Resta solo finché appartiene ancora a questa vista (non archiviata, non spostata altrove).
  const belongsHere = (c: ConversationListItem) =>
    c.isSpam === (projectKey === SYSTEM_SPAM) &&
    (projectKey === SYSTEM_SPAM || (c.projectId ?? null) === (isProject ? projectKey : null)) &&
    (projectKey === SYSTEM_SPAM || isProject || c.isNoise === (projectKey === SYSTEM_NEWS)) &&
    (view === 'important' || c.archived === archived);
  const sticky = stickyId
    ? (unreadItems.find((c) => c.id === stickyId) ?? (stickyItemQuery.data && belongsHere(stickyItemQuery.data) ? stickyItemQuery.data : undefined))
    : undefined;
  const unreadShown = sticky && !unreadItems.some((c) => c.id === sticky.id) ? [...unreadItems, sticky].sort((a, b) => b.sortAt - a.sortAt) : unreadItems;
  /** Tutte le righe caricate nell'ordine in cui compaiono (per Maiusc+clic e "Seleziona tutte"). */
  const items = [...unreadShown, ...dateGroups.flatMap((g) => groupItems[g.key] ?? [])];

  // Gruppi aperti (ricordati nel browser, per tutte le viste): di base solo "Da leggere".
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(readOpenGroups);
  // Gruppo aperto per mostrare la conversazione arrivata da un link (solo per questa volta, non ricordato).
  const [revealKey, setRevealKey] = useState<string | null>(null);
  useEffect(() => setRevealKey(null), [query]);
  const isOpen = (key: string) => key === revealKey || (openGroups[key] ?? key === 'unread');
  const toggleGroup = (key: string) => {
    const next = { ...openGroups, [key]: !isOpen(key) };
    if (key === revealKey) setRevealKey(null);
    setOpenGroups(next);
    writeOpenGroups(next);
  };

  // Selezione multipla (caselle a sinistra delle righe): azioni cumulative nella barra sotto l'intestazione.
  // Maiusc+clic seleziona l'intervallo dall'ultima spuntata. Esc deseleziona. Cambiando vista si azzera.
  const [selected, setSelected] = useState<string[]>([]);
  const lastPicked = useRef<string | null>(null);
  const shiftPick = useRef(false);
  useEffect(() => setSelected([]), [query]);
  // Esc: prima deseleziona, poi chiude la conversazione aperta (se non si sta scrivendo e non c'è un popup).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], .pm-ctx-layer, .pm-results')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (selected.length) setSelected([]);
      else if (conversationId) unfocusRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.length, conversationId]);
  const unfocusRef = useRef<() => void>(() => {});
  const toggleSelect = (id: string, range: boolean) => {
    const on = !selected.includes(id);
    const ids = items.map((c) => c.id);
    const from = lastPicked.current ? ids.indexOf(lastPicked.current) : -1;
    const to = ids.indexOf(id);
    const span = range && from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    lastPicked.current = id;
    setSelected(on ? [...new Set([...selected, ...span])] : selected.filter((x) => !span.includes(x)));
  };
  const selectBox = (c: ConversationListItem) => (
    <label className="pm-selbox" title="Seleziona (Maiusc+clic per un intervallo)">
      <input
        type="checkbox"
        checked={selected.includes(c.id)}
        aria-label={`Seleziona «${c.summary ?? c.subject ?? 'conversazione'}»`}
        // Il Maiusc si legge al clic; il cambio vero passa da onChange (bloccare il clic sulla casella la desincronizza).
        onClick={(e) => (shiftPick.current = e.shiftKey)}
        onChange={() => {
          toggleSelect(c.id, shiftPick.current);
          shiftPick.current = false;
        }}
      />
    </label>
  );
  const row = (c: ConversationListItem) => {
    const isFocused = c.id === conversationId;
    return (
      <div
        key={c.id}
        className={`pm-selrow${selected.includes(c.id) ? ' is-selected' : ''}${c.unreadCount ? ' is-unread' : ' is-read'}${isFocused ? ' is-focused' : ''}`}
      >
        {selectBox(c)}
        <ConversationItem
          c={c}
          focused={isFocused}
          selectedMessageId={isFocused ? messageId : null}
          cb={{
            onFocus: () => focus(c.id),
            onUnfocus: unfocus,
            onOpenMessage: (mid) => pane.openMessage(c.id, mid),
            onCompose: (r) => pane.compose({ conversationId: r.replyTo ? c.id : null, ...r }),
          }}
        />
      </div>
    );
  };

  // Il focus si ricorda per progetto: tornando sulla tab si ritrova (§2.3, regola 1).
  useEffect(() => {
    if (conversationId) writeFocus(projectKey, conversationId);
    else if (!unreadList.isLoading && !groupsQuery.isLoading && !draftId) {
      const remembered = readFocus(projectKey);
      if (remembered && items.some((c) => c.id === remembered)) navigate(paths.conversation(projectKey, remembered), { replace: true });
    }
  }, [conversationId, draftId, projectKey, unreadList.isLoading, groupsQuery.isLoading, items, navigate]);

  // Arrivando da un link (ricerca, contatti, task) la conversazione può stare in un gruppo chiuso: si apre
  // quel gruppo, lo si carica fino a lei e si scorre lì. Solo se non appartiene a questa vista (es. archiviata
  // mentre si guardano le attive) la si mostra in cima alla lista.
  const loaded = !!conversationId && items.some((c) => c.id === conversationId);
  const pinnedQuery = useQuery({
    queryKey: ['conversation-item', conversationId],
    queryFn: () => api.conversationItem(conversationId!),
    enabled: !!conversationId && !loaded,
  });
  const target = conversationId && !loaded ? pinnedQuery.data : undefined;
  const targetGroup = target ? dateGroupOf(target.sortAt) : null;
  const revealable =
    !!target &&
    !person &&
    belongsHere(target) &&
    (view !== 'important' || target.important) &&
    !target.unreadCount &&
    dateGroups.some((g) => g.key === targetGroup!.key && g.from === targetGroup!.from);
  useEffect(() => {
    if (revealable && targetGroup && !isOpen(targetGroup.key)) setRevealKey(targetGroup.key);
  }, [revealable, targetGroup?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const pinned = target && !revealable ? target : undefined;
  const found = loaded || !!pinned;
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationId || !found || scrolledTo.current === conversationId) return;
    scrolledTo.current = conversationId;
    const el = document.querySelector(`[data-conversation="${CSS.escape(conversationId)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Salto immediato: con una lista lunga lo scorrimento animato è lento e disorienta.
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'start' });
  }, [conversationId, found]);

  const focus = (id: string) => navigate(paths.conversation(projectKey, id));
  const unfocus = () => {
    writeFocus(projectKey, null);
    navigate(paths.project(projectKey));
  };
  unfocusRef.current = unfocus;
  const total = isProject
    ? (project?.conversationCount ?? items.length)
    : projectKey === SYSTEM_INBOX
      ? (counts?.inbox ?? items.length)
      : projectKey === SYSTEM_SPAM
        ? (counts?.spam ?? items.length)
        : (counts?.noise ?? items.length);

  // Prima di lasciare la lista per la vista Email se ne ricorda la posizione (il ritorno riparte da lì).
  const listEl = useRef<HTMLDivElement | null>(null);
  const scrollKey = `${projectKey}:${view}`;
  const rememberScroll = () => {
    if (listEl.current) savedScroll.set(scrollKey, listEl.current.scrollTop);
  };
  const pane: PaneAction = useMemo(
    () => ({
      openMessage: (cid, mid) => {
        rememberScroll();
        navigate(paths.message(projectKey, cid, mid));
      },
      compose: (request) => {
        rememberScroll();
        navigate(composeTarget(projectKey, request), { state: { seed: seedOf(request) } });
      },
      openNote: () => {},
      openTasks: () => {},
      close: () => {},
    }),
    [navigate, projectKey, scrollKey], // eslint-disable-line react-hooks/exhaustive-deps
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

  // Tornando dalla vista Email la lista riprende dal punto in cui era.
  const mailOpen = !!(messageId || draftId);
  useLayoutEffect(() => {
    if (mailOpen) return;
    const y = savedScroll.get(scrollKey);
    if (listEl.current && y) listEl.current.scrollTop = y;
  }, [mailOpen, scrollKey]);

  // S2/S3: il carosello prende il posto della lista; la conversazione resta in focus al ritorno.
  if (messageId || draftId) {
    return <MailView key={conversationId ?? 'new-mail'} projectKey={projectKey} conversationId={conversationId} messageId={messageId} draftId={draftId} />;
  }

  const unread = isProject ? (project?.unreadCount ?? 0) : projectKey === SYSTEM_INBOX ? (counts?.inboxUnread ?? 0) : projectKey === SYSTEM_NEWS ? (counts?.noiseUnread ?? 0) : 0;
  const importantCount = important[projectKey] ?? 0;
  // Da smistare ha la sua lista di task, come un progetto.
  const hasTasks = isProject || projectKey === SYSTEM_INBOX;
  const openTasks = isProject ? (project?.openTaskCount ?? 0) : (counts?.inboxOpenTasks ?? 0);
  const overdue = isProject ? (project?.overdueTaskCount ?? 0) : (counts?.inboxOverdueTasks ?? 0);
  const late = overdue > 0;

  return (
    <div className="pm-project">
      <h1 className="pm-sr-only">{project?.name ?? (projectKey === SYSTEM_INBOX ? 'Da smistare' : projectKey === SYSTEM_SPAM ? 'Spam' : 'News')}</h1>
      <div className="pm-project__main">
      <section className="pm-convlist" aria-label="Conversazioni">
        <div className="pm-projheader">
          {/* Con conversazioni selezionate, la barra delle azioni copre l'intestazione: la lista non si sposta. */}
          {selected.length > 0 && (
            <BulkBar
              ids={selected}
              projectKey={projectKey}
              archivedView={archived}
              total={items.length}
              onSelectAll={() => setSelected(items.map((c) => c.id))}
              onClear={() => setSelected([])}
              onMerged={(id) => focus(id)}
            />
          )}
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
            {hasTasks && (
              <button
                type="button"
                className={`pm-taskbtn${openTasks ? ' pm-taskbtn--has' : ''}${late ? ' pm-taskbtn--late' : ''}`}
                aria-pressed={tasksOpen}
                aria-label={`Task ${isProject ? 'del progetto' : 'di Da smistare'}: ${openTasks} aperti${late ? `, ${overdue} scaduti` : ''}`}
                title={isProject ? 'Task del progetto' : 'Task di Da smistare'}
                onClick={() => setTasksOpen(!tasksOpen)}
              >
                <Icon name={late ? 'assignment_late' : 'assignment'} size={18} />
                {openTasks > 0 && <span>{openTasks}</span>}
              </button>
            )}
          </div>
        </div>
        <div
          ref={listEl}
          className={`pm-convstack${selected.length ? ' pm-convstack--selecting' : ''}`}
          onScroll={(e) => savedScroll.set(scrollKey, e.currentTarget.scrollTop)}
        >
          {pinned && (
            <div className={`pm-selrow pm-selrow--pinned is-focused${selected.includes(pinned.id) ? ' is-selected' : ''}`}>
            {selectBox(pinned)}
            <ConversationItem
              key={`pinned-${pinned.id}`}
              c={pinned}
              focused
              selectedMessageId={messageId}
              cb={{
                onFocus: () => focus(pinned.id),
                onUnfocus: unfocus,
                onOpenMessage: (mid) => pane.openMessage(pinned.id, mid),
                onCompose: (r) => pane.compose({ conversationId: r.replyTo ? pinned.id : null, ...r }),
              }}
            />
            </div>
          )}
          {/* Account collegato ma ancora nessun progetto: lo smistamento non ha dove proporre. */}
          {projectKey === SYSTEM_INBOX && !archived && projectsLoaded && !projects.some((p) => !p.archived) && (
            <div className="pm-welcomehint">
              <span>Crea i tuoi progetti: l'analizzatore potrà proporre subito dove smistare la posta.</span>
              <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => navigate('/welcome?step=2')}>
                Procedura guidata
              </button>
            </div>
          )}
          {(groupsQuery.isLoading || unreadList.isLoading) && !pinned && <div className="pm-empty">Caricamento…</div>}
          {!groupsQuery.isLoading && !unreadList.isLoading && unreadShown.length === 0 && dateGroups.length === 0 && (
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
          {unreadShown.length > 0 && (
            <section className="pm-cgroup" aria-label="Da leggere">
              <GroupHead label="Da leggere" count={unreadShown.length} open={isOpen('unread')} onToggle={() => toggleGroup('unread')} />
              {(isOpen('unread') ? unreadShown : unreadShown.filter((c) => c.id === conversationId)).length > 0 && (
                <div className="pm-clist">{(isOpen('unread') ? unreadShown : unreadShown.filter((c) => c.id === conversationId)).map(row)}</div>
              )}
            </section>
          )}
          {dateGroups.map((g) => (
            <DateGroupSection
              key={`${g.key}-${g.from}`}
              group={g}
              query={query}
              open={isOpen(g.key)}
              onToggle={() => toggleGroup(g.key)}
              hiddenId={sticky?.id ?? null}
              targetId={revealable && targetGroup?.key === g.key ? conversationId : null}
              onItems={onGroupItems}
              row={row}
            />
          ))}
        </div>
      </section>
      {hasTasks && tasksOpen && <TasksSidebar projectId={projectKey} onClose={() => setTasksOpen(false)} />}
      </div>

    </div>
  );
}
