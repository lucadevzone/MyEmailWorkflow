import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import type { ServerEvent, SyncStatusDto } from '@mmw/shared';

/** Collega l'interfaccia agli eventi del server (SSE) e invalida le query interessate. */
export function useServerEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/events');
    // Alla (ri)connessione i dati possono essere cambiati mentre eravamo scollegati
    // (riavvio del server, rete assente): si ricarica tutto.
    let connectedOnce = false;
    es.onopen = () => {
      if (connectedOnce) qc.invalidateQueries();
      connectedOnce = true;
    };
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as ServerEvent;
      if (event.type === 'sync') {
        qc.setQueryData<SyncStatusDto[]>(['sync'], (prev = []) => mergeStatuses(prev, [event.status]));
      } else if (event.type === 'conversations') {
        qc.invalidateQueries({ queryKey: ['conversations'] });
        qc.invalidateQueries({ queryKey: ['counts'] });
        qc.invalidateQueries({ queryKey: ['important-counts'] });
        qc.invalidateQueries({ queryKey: ['task-suggestions'] }); // i suggerimenti nascono con l'analisi della conversazione
        qc.invalidateQueries({ queryKey: ['projects'] });
        qc.invalidateQueries({ queryKey: ['people'] });
        for (const id of event.ids) qc.invalidateQueries({ queryKey: ['conversation', id] });
      } else if (event.type === 'projects') {
        qc.invalidateQueries({ queryKey: ['projects'] });
        qc.invalidateQueries({ queryKey: ['categories'] });
      } else if (event.type === 'activities') {
        qc.invalidateQueries({ queryKey: ['activities'] });
      } else if (event.type === 'people') {
        qc.invalidateQueries({ queryKey: ['people'] });
        qc.invalidateQueries({ queryKey: ['directory'] });
        qc.invalidateQueries({ queryKey: ['project-members'] });
      } else if (event.type === 'tasks') {
        qc.invalidateQueries({ queryKey: ['tasks'] });
        qc.invalidateQueries({ queryKey: ['projects'] }); // badge dei task nella barra
      }
    };
    return () => es.close();
  }, [qc]);
}

/** Per ogni account tiene lo stato più recente: una lettura HTTP lenta non deve sovrascrivere un evento più nuovo. */
function mergeStatuses(prev: SyncStatusDto[], next: SyncStatusDto[]): SyncStatusDto[] {
  const byId = new Map(prev.map((s) => [s.accountId, s]));
  for (const s of next) {
    const old = byId.get(s.accountId);
    if (!old || s.updatedAt >= old.updatedAt) byId.set(s.accountId, s);
  }
  return [...byId.values()];
}

async function fetchStatuses(qc: QueryClient) {
  const fresh = await api.syncStatus();
  const prev = qc.getQueryData<SyncStatusDto[]>(['sync']) ?? [];
  // Gli account non più sincronizzati spariscono; per gli altri vince lo stato più recente.
  return mergeStatuses(prev.filter((p) => fresh.some((f) => f.accountId === p.accountId)), fresh);
}

export function useSyncStatuses() {
  const qc = useQueryClient();
  return useQuery({ queryKey: ['sync'], queryFn: () => fetchStatuses(qc), refetchInterval: 30_000 }).data ?? [];
}
