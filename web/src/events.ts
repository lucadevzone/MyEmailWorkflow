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
    // Durante un'importazione arrivano molti eventi di fila: le query da aggiornare si raccolgono e si
    // ricaricano al massimo una volta al secondo, invece di accodare al server una raffica di richieste.
    const pending = new Map<string, readonly unknown[]>();
    let timer: number | null = null;
    const inv = (key: readonly unknown[]) => {
      pending.set(JSON.stringify(key), key);
      timer ??= window.setTimeout(() => {
        timer = null;
        const keys = [...pending.values()];
        pending.clear();
        for (const k of keys) void qc.invalidateQueries({ queryKey: k });
      }, 1000);
    };
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as ServerEvent;
      if (event.type === 'sync') {
        qc.setQueryData<SyncStatusDto[]>(['sync'], (prev = []) => mergeStatuses(prev, [event.status]));
      } else if (event.type === 'conversations') {
        inv(['conversations']);
        inv(['counts']);
        inv(['important-counts']);
        inv(['task-suggestions']); // i suggerimenti nascono con l'analisi della conversazione
        inv(['conversation-item']);
        inv(['projects']);
        inv(['people']);
        for (const id of event.ids) inv(['conversation', id]);
      } else if (event.type === 'projects') {
        inv(['projects']);
        inv(['categories']);
      } else if (event.type === 'activities') {
        inv(['activities']);
      } else if (event.type === 'people') {
        inv(['people']);
        inv(['directory']);
        inv(['project-members']);
      } else if (event.type === 'tasks') {
        inv(['tasks']);
        inv(['projects']); // badge dei task nella barra
        inv(['counts']); // task di Da smistare
      }
    };
    return () => {
      es.close();
      if (timer) window.clearTimeout(timer);
    };
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
