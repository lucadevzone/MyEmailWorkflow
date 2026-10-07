import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerEvent, SyncStatusDto } from '@mmw/shared';

/** Collega l'interfaccia agli eventi del server (SSE) e invalida le query interessate. */
export function useServerEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as ServerEvent;
      if (event.type === 'sync') {
        qc.setQueryData<SyncStatusDto[]>(['sync'], (prev = []) => [
          ...prev.filter((s) => s.accountId !== event.status.accountId),
          event.status,
        ]);
      } else if (event.type === 'conversations') {
        qc.invalidateQueries({ queryKey: ['conversations'] });
        qc.invalidateQueries({ queryKey: ['counts'] });
        for (const id of event.ids) qc.invalidateQueries({ queryKey: ['conversation', id] });
      }
    };
    return () => es.close();
  }, [qc]);
}
