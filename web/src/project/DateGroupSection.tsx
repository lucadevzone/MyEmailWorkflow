// Un gruppo per data della lista (Oggi, Ieri, … i mesi, gli anni). Chiuso mostra solo l'intestazione con
// il numero di conversazioni; aperto carica le sue conversazioni a pagine, man mano che si scorre (senza
// pulsante "Carica altre").

import { useEffect, useRef, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ConversationListItem, ConversationQuery, DateGroupCount } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';

const PAGE = 50;

export function GroupHead({ label, count, open, onToggle }: { label: string; count?: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="pm-cgroup__head" aria-expanded={open} onClick={onToggle}>
      <Ic icon={open ? ChevronDown : ChevronRight} size={15} />
      <span>{label}</span>
      {count !== undefined && <span className="pm-cgroup__count">{count}</span>}
    </button>
  );
}

export function DateGroupSection({ group, query, open, onToggle, hiddenId, targetId, onItems, row }: {
  group: DateGroupCount;
  query: ConversationQuery;
  open: boolean;
  onToggle: () => void;
  /** Conversazione mostrata altrove (aperta mentre era da leggere): qui non si ripete. */
  hiddenId: string | null;
  /** Conversazione arrivata da un link che sta in questo gruppo: si caricano pagine finché non compare. */
  targetId: string | null;
  /** Le conversazioni caricate (per la selezione a intervallo e "Seleziona tutte"). */
  onItems: (key: string, items: ConversationListItem[]) => void;
  row: (c: ConversationListItem) => ReactNode;
}) {
  return (
    <section className="pm-cgroup" aria-label={group.label}>
      <GroupHead label={group.label} count={group.count} open={open} onToggle={onToggle} />
      {open && <GroupRows group={group} query={query} hiddenId={hiddenId} targetId={targetId} onItems={onItems} row={row} />}
    </section>
  );
}

function GroupRows({ group, query, hiddenId, targetId, onItems, row }: Omit<Parameters<typeof DateGroupSection>[0], 'open' | 'onToggle'>) {
  const list = useInfiniteQuery({
    queryKey: ['conversations', query, 'group', group.key, group.from],
    queryFn: ({ pageParam }) => api.conversations({ ...query, unread: 'exclude', after: group.from, before: pageParam ?? group.to ?? undefined }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1]!.sortAt),
  });
  const items = (list.data?.pages.flat() ?? []).filter((c) => c.id !== hiddenId);

  useEffect(() => {
    onItems(group.key, items);
  }, [list.data, hiddenId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Chiuso il gruppo, le sue righe non contano più come caricate.
  useEffect(() => () => onItems(group.key, []), []); // eslint-disable-line react-hooks/exhaustive-deps

  // La conversazione cercata non è ancora tra quelle caricate: avanti con le pagine (al massimo 60).
  useEffect(() => {
    if (!targetId || items.some((c) => c.id === targetId)) return;
    if (list.hasNextPage && !list.isFetchingNextPage && (list.data?.pages.length ?? 0) < 60) void list.fetchNextPage();
  }, [targetId, list.data, list.hasNextPage, list.isFetchingNextPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrivati in fondo al gruppo si carica la pagina successiva.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !list.hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !list.isFetchingNextPage) void list.fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.hasNextPage, list.isFetchingNextPage, list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (list.isLoading) return <div className="pm-cgroup__loading">Caricamento…</div>;
  return (
    <>
      {items.length > 0 && <div className="pm-clist">{items.map(row)}</div>}
      {list.hasNextPage && (
        <div ref={sentinel} className="pm-cgroup__loading">
          {list.isFetchingNextPage ? 'Caricamento…' : ''}
        </div>
      )}
    </>
  );
}
