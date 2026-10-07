import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Badge } from '../ui/Badge.tsx';
import { Icon } from '../ui/Icon.tsx';
import { sameNav, type Nav } from './nav.ts';

/** Barra superiore: [totale non letti] Da smistare · progetti · Rumore · + */
export function TopBar({ nav, onNav, onNewProject }: { nav: Nav; onNav: (n: Nav) => void; onNewProject: () => void }) {
  const { data: counts } = useQuery({ queryKey: ['counts'], queryFn: api.conversationCounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const active = projects.filter((p) => !p.archived);

  const tab = (n: Nav, label: string, unread?: number) => {
    const selected = sameNav(nav, n);
    return (
      <button
        key={n.kind === 'project' ? n.projectId : n.kind}
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
  };

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
