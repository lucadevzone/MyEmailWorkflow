import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useMatch, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowRightLeft, Inbox, Plus, RefreshCw, Search, SlidersHorizontal, Users } from 'lucide-react';
import { SearchBox } from './Search.tsx';
import { useEditing } from '../ui/editing.tsx';
import { ProjectsEditor } from './ProjectsEditor.tsx';
import type { ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useContextMenu, type MenuAction } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS, SYSTEM_SPAM } from './paths.ts';

/** Barra superiore (D1/D2): tab dei progetti tra i due progetti di sistema; a destra Contatti e Impostazioni. */
export function TopBar({ onNewProject, onEditProject }: { onNewProject: () => void; onEditProject: (p: ProjectDto) => void }) {
  const editing = useEditing();
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const active = projects.filter((p) => !p.archived);
  const [searching, setSearching] = useState(false);

  // "/" apre la ricerca da qualunque punto (tranne mentre si scrive).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      setSearching(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (editing.mode === 'projects') return <ProjectsEditor onDone={() => editing.setMode(null)} />;

  return (
    <header className={`pm-topbar${searching ? ' pm-topbar--searching' : ''}`}>
      {searching ? (
        <SearchBox onClose={() => setSearching(false)} />
      ) : (
        <button type="button" className="pm-iconbtn" aria-label="Cerca in tutti i progetti" title="Cerca (/)" onClick={() => setSearching(true)}>
          <Ic icon={Search} />
        </button>
      )}
      {!searching && <CheckMailButton />}
      <span className="pm-topbar__sep" aria-hidden="true" />
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
        <Tab to={paths.project(SYSTEM_NEWS)} label="News" unread={counts?.noiseUnread} muted />
        <Tab to={paths.project(SYSTEM_SPAM)} label="Spam" total={counts?.spam} muted />
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

function Tab({ to, label, icon, unread, total, project, onEditProject, muted }: {
  to: string;
  label: string;
  icon?: boolean;
  unread?: number;
  /** Solo "Da smistare": quante conversazioni attendono di essere smistate. */
  total?: number;
  project?: ProjectDto;
  onEditProject?: (p: ProjectDto) => void;
  /** News e Spam: contatore grigio, meno in evidenza. */
  muted?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  // La tab resta attiva anche dentro conversazioni e messaggi del progetto.
  const current = !!useMatch({ path: to, end: false });
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['activities']]) qc.invalidateQueries({ queryKey: k });
  };
  const view = to.endsWith(`/${SYSTEM_INBOX}`) ? 'inbox' : to.endsWith(`/${SYSTEM_NEWS}`) ? 'noise' : to.endsWith(`/${SYSTEM_SPAM}`) ? 'spam' : 'project';
  const markRead = async () => {
    if (view === 'spam') return;
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
      ...(view === 'spam' ? [] : [{ id: 'read', icon: 'mark_email_read', label: 'Segna tutto come letto', primary: true, run: markRead }]),
    ];
    if (project && onEditProject) actions.push({ id: 'edit', icon: 'tune', label: 'Modifica progetto', primary: true, run: () => onEditProject(project) });
    return { title: label, actions };
  });

  const count = unread ? unread : total;
  return (
    <NavLink to={to} className="pm-tab" aria-current={current ? 'page' : undefined} {...ctx}>
      {icon && <Ic icon={Inbox} size={15} />}
      {label}
      {!!count && <span className={`pm-tab__count${unread && !muted ? ' pm-tab__count--unread' : ''}`}>{count > 99 ? '99+' : count}</span>}
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
    <button type="button" className="pm-iconbtn" aria-label="Ricevi nuovi messaggi" title="Ricevi nuovi messaggi" onClick={() => void run()} disabled={busy}>
      <Ic icon={RefreshCw} className={busy ? 'pm-spin' : undefined} />
    </button>
  );
}
