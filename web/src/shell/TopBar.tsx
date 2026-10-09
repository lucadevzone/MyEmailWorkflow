import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useMatch, useNavigate } from 'react-router-dom';
import { ArrowRightLeft, Inbox, Plus, SlidersHorizontal, Users } from 'lucide-react';
import { useEditing } from '../ui/editing.tsx';
import { ProjectsEditor } from './ProjectsEditor.tsx';
import type { ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useContextMenu, type MenuAction } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS } from './paths.ts';

/** Barra superiore (D1/D2): tab dei progetti tra i due progetti di sistema; a destra Contatti e Impostazioni. */
export function TopBar({ onNewProject, onEditProject }: { onNewProject: () => void; onEditProject: (p: ProjectDto) => void }) {
  const editing = useEditing();
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const active = projects.filter((p) => !p.archived);

  if (editing.mode === 'projects') return <ProjectsEditor onDone={() => editing.setMode(null)} />;

  return (
    <header className="pm-topbar">
      <nav className="pm-topbar__tabs" aria-label="Progetti">
        <Tab to={paths.project(SYSTEM_INBOX)} label="Da smistare" icon unread={counts?.inboxUnread} total={counts?.inbox} />
        <span className="pm-topbar__tabsep" aria-hidden="true" />
        {active.map((p) => (
          <Tab key={p.id} to={paths.project(p.id)} label={p.name} unread={p.unreadCount} project={p} onEditProject={onEditProject} />
        ))}
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Nuovo progetto" title="Nuovo progetto" onClick={onNewProject}>
          <Ic icon={Plus} size={15} />
        </button>
        {active.length > 0 && (
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Riordina o rimuovi progetti" title="Gestisci progetti" onClick={() => editing.setMode('projects')}>
            <Ic icon={ArrowRightLeft} size={15} />
          </button>
        )}
        <span className="pm-topbar__tabsep" aria-hidden="true" />
        <Tab to={paths.project(SYSTEM_NEWS)} label="News" unread={counts?.noiseUnread} />
      </nav>
      <div className="pm-topbar__tools">
        <NavLink to={paths.contacts()} className="pm-iconbtn" aria-label="Contatti e gruppi" title="Contatti e gruppi">
          <Ic icon={Users} />
        </NavLink>
        <NavLink to={paths.settings()} className="pm-iconbtn" aria-label="Impostazioni" title="Impostazioni">
          <Ic icon={SlidersHorizontal} />
        </NavLink>
      </div>
    </header>
  );
}

function Tab({ to, label, icon, unread, total, project, onEditProject }: {
  to: string;
  label: string;
  icon?: boolean;
  unread?: number;
  /** Solo "Da smistare": quante conversazioni attendono di essere smistate. */
  total?: number;
  project?: ProjectDto;
  onEditProject?: (p: ProjectDto) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  // La tab resta attiva anche dentro conversazioni e messaggi del progetto.
  const current = !!useMatch({ path: to, end: false });
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['activities']]) qc.invalidateQueries({ queryKey: k });
  };
  const view = to.endsWith(`/${SYSTEM_INBOX}`) ? 'inbox' : to.endsWith(`/${SYSTEM_NEWS}`) ? 'noise' : 'project';
  const markRead = async () => {
    const res = view === 'project' ? await api.markViewRead('project', project!.id) : await api.markViewRead(view);
    refresh();
    toast({
      text: res.count ? `${res.count} messaggi segnati come letti` : 'Niente da segnare come letto',
      action: res.count ? { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) } : undefined,
    });
  };
  const ctx = useContextMenu(() => {
    const actions: MenuAction[] = [
      { id: 'open', icon: 'open_in_new', label: `Apri ${label}`, run: () => navigate(to) },
      { id: 'read', icon: 'mark_email_read', label: 'Segna tutto come letto', primary: true, run: markRead },
    ];
    if (project && onEditProject) actions.push({ id: 'edit', icon: 'tune', label: 'Modifica progetto', primary: true, run: () => onEditProject(project) });
    return { title: label, actions };
  });

  const count = unread ? unread : total;
  return (
    <NavLink to={to} className="pm-tab" aria-current={current ? 'page' : undefined} {...ctx}>
      {icon && <Ic icon={Inbox} size={15} />}
      {label}
      {!!count && <span className={`pm-tab__count${unread ? ' pm-tab__count--unread' : ''}`}>{count > 99 ? '99+' : count}</span>}
    </NavLink>
  );
}
