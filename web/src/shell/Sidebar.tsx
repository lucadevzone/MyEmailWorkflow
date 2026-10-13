// Barra laterale dei progetti (UI v2): Da smistare in cima, i progetti raggruppati per categoria, News e
// Spam in fondo. Aperta mostra i nomi; chiusa diventa una colonna stretta con le iniziali e i badge.
// Si apre e si chiude solo a mano (pulsante nella barra superiore); la scelta resta ricordata.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useMatch, useNavigate } from 'react-router-dom';
import { ArrowDownUp, Ban, ChevronDown, ChevronRight, Inbox, Newspaper, Plus, RefreshCw } from 'lucide-react';
import type { ProjectCategoryDto, ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useContextMenu, type MenuAction } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { useEditing } from '../ui/editing.tsx';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS, SYSTEM_SPAM } from './paths.ts';

const KEY = 'mmw.sidebar';

/** Barra aperta o chiusa, ricordata nel browser. */
export function useSidebarState(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(KEY, v ? 'open' : 'closed');
    } catch {
      /* solo una comodità */
    }
  };
  return [open, set];
}

/** Progetti attivi raggruppati per categoria, nell'ordine scelto; "Senza categoria" in fondo. */
export function groupProjects(projects: ProjectDto[], categories: ProjectCategoryDto[]) {
  const active = projects.filter((p) => !p.archived);
  const known = new Set(categories.map((c) => c.id));
  const groups = categories.map((c) => ({ category: c as ProjectCategoryDto | null, projects: active.filter((p) => p.categoryId === c.id) }));
  const loose = active.filter((p) => !p.categoryId || !known.has(p.categoryId));
  if (loose.length) groups.push({ category: null, projects: loose });
  return groups;
}

/** Due lettere per la barra chiusa: le iniziali delle prime due parole, oppure le prime due lettere. */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const s = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}

const taskLabel = (p: { openTaskCount: number; overdueTaskCount: number }) =>
  `${p.openTaskCount} task aperti${p.overdueTaskCount ? `, ${p.overdueTaskCount} scaduti` : ''}`;

export function Sidebar({ open, onNewProject, onEditProject, floating }: {
  open: boolean;
  onNewProject: () => void;
  onEditProject: (p: ProjectDto) => void;
  /** Sopra il contenuto (viste Email, Contatti, Impostazioni), si chiude scegliendo una voce. */
  floating?: () => void;
}) {
  const qc = useQueryClient();
  const editing = useEditing();
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const groups = groupProjects(projects, categories);
  const active = projects.filter((p) => !p.archived);

  const toggleCategory = async (c: ProjectCategoryDto) => {
    // Subito nella barra, poi sul server.
    qc.setQueryData<ProjectCategoryDto[]>(['categories'], (old) => old?.map((x) => (x.id === c.id ? { ...x, collapsed: !c.collapsed } : x)));
    await api.updateCategory(c.id, { collapsed: !c.collapsed }).catch(() => qc.invalidateQueries({ queryKey: ['categories'] }));
  };

  if (!open) {
    return (
      <nav className="pm-sidebar pm-sidebar--closed" aria-label="Progetti">
        <RailLink to={paths.project(SYSTEM_INBOX)} label="Da smistare" unread={counts?.inboxUnread} total={counts?.inbox} icon={<Ic icon={Inbox} />} />
        <span className="pm-sidebar__rule" aria-hidden="true" />
        {groups.flatMap((g) => g.projects).map((p) => (
          <RailLink key={p.id} to={paths.project(p.id)} label={p.name} unread={p.unreadCount} project={p} onEditProject={onEditProject} />
        ))}
        <span className="pm-sidebar__rule" aria-hidden="true" />
        <RailLink to={paths.project(SYSTEM_NEWS)} label="News" total={counts?.noiseUnread} icon={<Ic icon={Newspaper} />} muted />
        <RailLink to={paths.project(SYSTEM_SPAM)} label="Spam" total={counts?.spam} icon={<Ic icon={Ban} />} muted />
      </nav>
    );
  }

  return (
    <nav className={`pm-sidebar${floating ? ' pm-sidebar--floating' : ''}`} aria-label="Progetti" onClick={(e) => floating && (e.target as HTMLElement).closest('a') && floating()}>
      <div className="pm-sidebar__head">
        <span className="pm-sidebar__label">Progetti</span>
        <span className="pm-spacer" />
        <CheckMailButton />
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Nuovo progetto" title="Nuovo progetto" onClick={onNewProject}>
          <Ic icon={Plus} size={15} />
        </button>
        {active.length > 0 && (
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Gestisci progetti e categorie" title="Gestisci progetti" onClick={() => editing.setMode('projects')}>
            <Ic icon={ArrowDownUp} size={15} />
          </button>
        )}
      </div>
      <div className="pm-sidebar__body">
        <Row
          to={paths.project(SYSTEM_INBOX)}
          label="Da smistare"
          icon={<Ic icon={Inbox} size={16} />}
          unread={counts?.inboxUnread}
          total={counts?.inbox}
          tasks={counts ? { openTaskCount: counts.inboxOpenTasks, overdueTaskCount: counts.inboxOverdueTasks } : undefined}
        />
        <span className="pm-sidebar__rule" aria-hidden="true" />
        {groups.map((g) => {
          const c = g.category;
          // Senza categorie create, i progetti stanno da soli, senza intestazione.
          if (!c && categories.length === 0) return g.projects.map((p) => <Row key={p.id} to={paths.project(p.id)} label={p.name} unread={p.unreadCount} project={p} onEditProject={onEditProject} />);
          const closed = !!c?.collapsed;
          const unread = g.projects.reduce((n, p) => n + p.unreadCount, 0);
          const tasks = g.projects.some((p) => p.openTaskCount > 0);
          const late = g.projects.some((p) => p.overdueTaskCount > 0);
          return (
            <section key={c?.id ?? 'none'} className="pm-sidebar__group">
              {c ? (
                <button type="button" className="pm-sidebar__cat" aria-expanded={!closed} onClick={() => void toggleCategory(c)}>
                  <Ic icon={closed ? ChevronRight : ChevronDown} size={14} />
                  <span className="pm-sidebar__catname">{c.name}</span>
                  {closed && tasks && (
                    <span className={`pm-sidebar__tasks${late ? ' pm-sidebar__tasks--late' : ''}`} title="Task aperti in questa categoria" aria-label="Task aperti in questa categoria">
                      <Icon name={late ? 'assignment_late' : 'assignment'} size={16} />
                    </span>
                  )}
                  {closed && unread > 0 && <span className="pm-badge">{unread > 99 ? '99+' : unread}</span>}
                </button>
              ) : (
                <div className="pm-sidebar__cat pm-sidebar__cat--static">
                  <span className="pm-sidebar__catname">Senza categoria</span>
                </div>
              )}
              {!closed && g.projects.map((p) => <Row key={p.id} to={paths.project(p.id)} label={p.name} unread={p.unreadCount} project={p} onEditProject={onEditProject} indent />)}
              {!closed && c && g.projects.length === 0 && <div className="pm-sidebar__empty">Nessun progetto</div>}
            </section>
          );
        })}
        <span className="pm-sidebar__rule" aria-hidden="true" />
        <Row to={paths.project(SYSTEM_NEWS)} label="News" icon={<Ic icon={Newspaper} size={16} />} unread={counts?.noiseUnread} muted />
        <Row to={paths.project(SYSTEM_SPAM)} label="Spam" icon={<Ic icon={Ban} size={16} />} total={counts?.spam} muted />
      </div>
    </nav>
  );
}

/** Menu del tasto destro su un progetto (o vista di sistema): segna come letto, modifica. */
function useProjectMenu(to: string, label: string, project?: ProjectDto, onEditProject?: (p: ProjectDto) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const view = to.endsWith(`/${SYSTEM_INBOX}`) ? 'inbox' : to.endsWith(`/${SYSTEM_NEWS}`) ? 'noise' : to.endsWith(`/${SYSTEM_SPAM}`) ? 'spam' : 'project';
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['activities']]) qc.invalidateQueries({ queryKey: k });
  };
  const markRead = async () => {
    if (view === 'spam') return;
    const res = view === 'project' ? await api.markViewRead('project', project!.id) : await api.markViewRead(view);
    refresh();
    toast({
      text: res.count ? `${res.count} messaggi segnati come letti` : 'Niente da segnare come letto',
      action: res.count ? { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) } : undefined,
    });
  };
  return useContextMenu(() => {
    const actions: MenuAction[] = [
      { id: 'open', icon: 'open_in_new', label: `Apri ${label}`, run: () => navigate(to) },
      ...(view === 'spam' ? [] : [{ id: 'read', icon: 'mark_email_read', label: 'Segna tutto come letto', primary: true, run: markRead }]),
    ];
    if (project && onEditProject) actions.push({ id: 'edit', icon: 'tune', label: 'Modifica progetto', primary: true, run: () => onEditProject(project) });
    return { title: label, actions };
  });
}

function Row({ to, label, icon, unread, total, project, onEditProject, muted, indent, tasks: taskCounts }: {
  to: string;
  label: string;
  icon?: React.ReactNode;
  unread?: number;
  /** Da smistare e Spam: quante conversazioni ci sono, in grigio. */
  total?: number;
  project?: ProjectDto;
  onEditProject?: (p: ProjectDto) => void;
  /** News e Spam: contatore grigio, meno in evidenza. */
  muted?: boolean;
  indent?: boolean;
  /** Task di Da smistare (per i progetti si leggono dal progetto). */
  tasks?: { openTaskCount: number; overdueTaskCount: number };
}) {
  // Resta attiva anche dentro conversazioni e messaggi del progetto.
  const current = !!useMatch({ path: to, end: false });
  const ctx = useProjectMenu(to, label, project, onEditProject);
  const count = unread || total;
  return (
    <NavLink to={to} className={`pm-sidebar__item${indent ? ' pm-sidebar__item--indent' : ''}`} aria-current={current ? 'page' : undefined} {...ctx}>
      {icon}
      <span className="pm-sidebar__name">{label}</span>
      {(() => {
        const t = project ?? taskCounts;
        if (!t?.openTaskCount) return null;
        return (
          <span className={`pm-sidebar__tasks${t.overdueTaskCount ? ' pm-sidebar__tasks--late' : ''}`} title={taskLabel(t)} aria-label={taskLabel(t)}>
            <Icon name={t.overdueTaskCount ? 'assignment_late' : 'assignment'} size={16} />
          </span>
        );
      })()}
      {!!count && <span className={`pm-badge${unread && !muted ? '' : ' pm-badge--muted'}`}>{count > 99 ? '99+' : count}</span>}
    </NavLink>
  );
}

/** Voce della barra chiusa: icona o iniziali, con il badge dei non letti in alto a destra. */
function RailLink({ to, label, icon, unread, total, project, onEditProject, muted }: {
  to: string;
  label: string;
  icon?: React.ReactNode;
  unread?: number;
  total?: number;
  project?: ProjectDto;
  onEditProject?: (p: ProjectDto) => void;
  muted?: boolean;
}) {
  const current = !!useMatch({ path: to, end: false });
  const ctx = useProjectMenu(to, label, project, onEditProject);
  const count = unread || total;
  const title = [label, unread ? `${unread} non letti` : null, project?.openTaskCount ? taskLabel(project) : null].filter(Boolean).join(' · ');
  return (
    <NavLink to={to} className={`pm-sidebar__mini${icon ? ' pm-sidebar__mini--icon' : ''}`} aria-current={current ? 'page' : undefined} aria-label={title} title={title} {...ctx}>
      {icon ?? initials(label)}
      {!!count && <span className={`pm-sidebar__minibadge${unread && !muted ? '' : ' pm-sidebar__minibadge--muted'}`}>{count > 99 ? '99+' : count}</span>}
    </NavLink>
  );
}

/** Controlla subito la posta, senza aspettare che il server la segnali. */
function CheckMailButton() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const statuses = await api.syncNow();
      const failed = statuses.find((s) => s.phase === 'error');
      if (failed) toast({ text: `Ricezione non riuscita: ${failed.error ?? 'errore di connessione'}` });
      else if (!statuses.length) toast({ text: 'Nessun account configurato' });
    } catch (err) {
      toast({ text: (err as Error).message });
    } finally {
      // Un giro minimo di animazione: i messaggi nuovi arrivano poi da soli nella lista.
      setTimeout(() => setBusy(false), 1200);
    }
  };
  return (
    <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Ricevi nuovi messaggi" title="Ricevi nuovi messaggi" onClick={() => void run()} disabled={busy}>
      <Ic icon={RefreshCw} size={15} className={busy ? 'pm-spin' : undefined} />
    </button>
  );
}
