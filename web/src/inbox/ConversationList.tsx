import { useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AccountDto, ConversationListItem, ConversationQuery } from '@mmw/shared';
import { api } from '../api.ts';
import { colorFor, personLabel, shortDate } from '../lib/format.ts';

const PAGE = 50;

export function ConversationList({
  query,
  title,
  subtitle,
  actions,
  emptyText,
  selectedId,
  onSelect,
}: {
  query: Omit<ConversationQuery, 'archived' | 'before'>;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  emptyText: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [archived, setArchived] = useState(false);
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const list = useInfiniteQuery({
    queryKey: ['conversations', query.view, query.projectId ?? null, archived],
    queryFn: ({ pageParam }) => api.conversations({ ...query, archived, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1]!.lastMessageAt),
  });
  const items = list.data?.pages.flat() ?? [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold">{title}</h1>
            {subtitle && <p className="line-clamp-2 text-xs text-stone-500">{subtitle}</p>}
          </div>
          {actions}
        </div>
        {query.view !== 'noise' && (
          <div className="flex gap-3 text-xs">
            <button className={!archived ? 'font-semibold' : 'text-stone-500'} onClick={() => setArchived(false)}>
              Attive
            </button>
            <button className={archived ? 'font-semibold' : 'text-stone-500'} onClick={() => setArchived(true)}>
              Archiviate
            </button>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading && <div className="p-4 text-sm text-stone-500">Caricamento…</div>}
        {!list.isLoading && items.length === 0 && (
          <div className="p-4 text-sm text-stone-500">{archived ? 'Nessuna conversazione archiviata.' : emptyText}</div>
        )}
        <ul>
          {items.map((c) => (
            <Row key={c.id} c={c} accounts={accountById} selected={c.id === selectedId} onSelect={onSelect} />
          ))}
        </ul>
        {list.hasNextPage && (
          <button
            className="w-full p-3 text-sm text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-900"
            onClick={() => list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? 'Caricamento…' : 'Carica altre'}
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
