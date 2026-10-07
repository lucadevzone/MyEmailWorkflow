import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AccountDto, ConversationListItem, ConversationView } from '@mmw/shared';
import { api } from '../api.ts';
import { colorFor, personLabel, shortDate } from '../lib/format.ts';

const PAGE = 50;

export function ConversationList({
  view,
  selectedId,
  onSelect,
}: {
  view: ConversationView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const query = useInfiniteQuery({
    queryKey: ['conversations', view],
    queryFn: ({ pageParam }) => api.conversations(view, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1]!.lastMessageAt),
  });
  const items = query.data?.pages.flat() ?? [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <h1 className="font-semibold">{view === 'inbox' ? 'Da smistare' : 'Rumore'}</h1>
        <p className="text-xs text-stone-500">
          {view === 'inbox'
            ? 'Conversazioni non ancora assegnate a un progetto'
            : 'Newsletter e notifiche automatiche'}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading && <div className="p-4 text-sm text-stone-500">Caricamento…</div>}
        {!query.isLoading && items.length === 0 && (
          <div className="p-4 text-sm text-stone-500">
            {view === 'inbox' ? 'Niente da smistare.' : 'Nessuna conversazione marcata come rumore.'}
          </div>
        )}
        <ul>
          {items.map((c) => (
            <Row key={c.id} c={c} accounts={accountById} selected={c.id === selectedId} onSelect={onSelect} />
          ))}
        </ul>
        {query.hasNextPage && (
          <button
            className="w-full p-3 text-sm text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-900"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Caricamento…' : 'Carica altre'}
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  c,
  accounts,
  selected,
  onSelect,
}: {
  c: ConversationListItem;
  accounts: Map<string, AccountDto>;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const unread = c.unreadCount > 0;
  const people = c.participants.length ? c.participants.slice(0, 3).map(personLabel).join(', ') : 'Solo io';
  return (
    <li>
      <button
        onClick={() => onSelect(c.id)}
        className={`block w-full border-b border-stone-100 px-4 py-3 text-left dark:border-stone-900 ${
          selected ? 'bg-stone-200/70 dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-900'
        }`}
      >
        <div className="flex items-baseline gap-2">
          {unread && <span className="size-2 shrink-0 self-center rounded-full bg-blue-600" aria-label="non letto" />}
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'font-semibold' : ''}`}>
            {people}
            {c.participants.length > 3 && <span className="text-stone-500"> +{c.participants.length - 3}</span>}
            {c.messageCount > 1 && <span className="ml-1 text-xs font-normal text-stone-500">{c.messageCount}</span>}
          </span>
          <span className="shrink-0 text-xs text-stone-500 tabular-nums">{shortDate(c.lastMessageAt)}</span>
        </div>
        <div className={`truncate text-sm ${unread ? 'font-medium' : 'text-stone-700 dark:text-stone-300'}`}>
          {c.subject || '(nessun oggetto)'}
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-stone-500">{c.snippet}</span>
          {c.hasAttachments && <span className="text-xs text-stone-500" title="Allegati">📎</span>}
          {c.accountIds.map((id) => {
            const a = accounts.get(id);
            if (!a) return null;
            return (
              <span
                key={id}
                className="shrink-0 rounded px-1.5 text-[10px] font-medium text-white"
                style={{ background: a.color ?? colorFor(a.email) }}
                title={a.email}
              >
                {a.name}
              </span>
            );
          })}
        </div>
      </button>
    </li>
  );
}
