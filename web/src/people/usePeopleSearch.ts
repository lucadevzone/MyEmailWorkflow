import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { PersonDto } from '@mmw/shared';
import { api } from '../api.ts';

/**
 * Cerca tra tutti gli indirizzi visti, non solo tra i più frequenti della rubrica (da 2 lettere,
 * con una breve attesa mentre si scrive).
 */
export function usePeopleSearch(text: string): PersonDto[] {
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(t);
  }, [text]);
  const { data = [] } = useQuery({
    queryKey: ['people-search', q],
    queryFn: () => api.searchPeople(q),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  return text.trim().length >= 2 ? data : [];
}
