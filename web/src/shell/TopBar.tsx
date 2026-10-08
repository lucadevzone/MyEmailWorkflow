import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@mmw/shared';
import { useContextMenu, type MenuAction } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { api } from '../api.ts';
import { Badge } from '../ui/Badge.tsx';
import { Icon } from '../ui/Icon.tsx';
import { sameNav, type Nav } from './nav.ts';

/** Barra superiore: [totale non letti] Da smistare · progetti · Rumore · + */
export type ProjectIntent = 'compose' | 'tasks';

export function TopBar({ nav, onNav, onNewProject, onEditProject, onProjectIntent }: {
  nav: Nav;
  onNav: (n: Nav) => void;
  onNewProject: () => void;
  onEditProject: (p: ProjectDto) => void;
  onProjectIntent: (projectId: string, intent: ProjectIntent) => void;
}) {
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const active = projects.filter((p) => !p.archived);

  const tab = (n: Nav, label: string, unread?: number) => (
    <Tab key={n.kind === 'project' ? n.projectId : n.kind} n={n} label={label} unread={unread} selected={sameNav(nav, n)} onNav={onNav} project={n.kind === 'project' ? active.find((p) => p.id === n.projectId) : undefined} onEditProject={onEditProject} onProjectIntent={onProjectIntent} />
  );

  return (
    <header className="flex items-center gap-1 overflow-x-auto border-b border-stone-200 bg-white px-3 dark:border-stone-800 dark:bg-stone-900">
      {!!counts?.totalUnread && (
        <span className="mr-1" title="Messaggi da leggere (escluso il rumore)">
          <Badge n={counts.totalUnread} tone="red" />
        </span>
      )}
      {tab({ kind: 'inbox' }, 'Da smistare', counts?.inboxUnread)}
      {active.map((p) => tab({ kind: 'project', projectId: p.id }, p.name, p.unreadCount))}
      {tab({ kind: 'noise' }, 'Rumore', counts?.noiseUnread)}
      <button
        onClick={onNewProject}
        className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-stone-100"
        title="Nuovo progetto"
      >
        <Icon name="add" />
      </button>
    </header>
  );
}

function Tab({ n, label, unread, selected, onNav, project, onEditProject, onProjectIntent }: {
  n: Nav;
  label: string;
  unread?: number;
  selected: boolean;
  onNav: (n: Nav) => void;
  project?: ProjectDto;
  onEditProject: (p: ProjectDto) => void;
  onProjectIntent: (projectId: string, intent: ProjectIntent) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['activities']]) qc.invalidateQueries({ queryKey: k });
  };
  const markRead = async () => {
    const res = n.kind === 'project' ? await api.markViewRead('project', n.projectId) : await api.markViewRead(n.kind as 'inbox' | 'noise');
    refresh();
    toast({
      text: res.count ? `${res.count} messaggi segnati come letti` : 'Niente da segnare come letto',
      action: res.count ? { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) } : undefined,
    });
  };
  const ctx = useContextMenu(() => {
    const actions: MenuAction[] = [{ id: 'open', icon: 'open_in_new', label: `Apri ${label}`, run: () => onNav(n) }];
    if (project) {
      actions.push(
        { id: 'compose', icon: 'edit', label: 'Nuova email', primary: true, run: () => onProjectIntent(project.id, 'compose') },
        { id: 'tasks', icon: 'checklist', label: 'Task', primary: true, run: () => onProjectIntent(project.id, 'tasks') },
        { id: 'edit', icon: 'tune', label: 'Modifica progetto', primary: true, run: () => onEditProject(project) },
        { id: 'read', icon: 'mark_email_read', label: 'Segna tutto come letto', run: markRead },
        {
          id: 'archive', icon: 'inventory_2', label: 'Archivia progetto', tone: 'danger',
          confirm: { message: `Archiviare il progetto «${project.name}»?`, okLabel: 'Archivia', danger: true },
          run: async () => {
            await api.updateProject(project.id, { archived: true });
            refresh();
            toast({ text: `Progetto «${project.name}» archiviato`, action: { label: 'Annulla', run: () => void api.updateProject(project.id, { archived: false }).then(refresh) } });
          },
        },
      );
    } else {
      actions.push({ id: 'read', icon: 'mark_email_read', label: 'Segna tutto come letto', primary: true, run: markRead });
    }
    return { title: label, actions };
  });

  return (
    <button
      {...ctx}
      onClick={() => onNav(n)}
      className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm ${
        selected
          ? 'border-stone-900 font-semibold dark:border-stone-100'
          : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100'
      }`}
    >
      {label}
      <Badge n={unread} tone="sky" />
    </button>
  );
}
