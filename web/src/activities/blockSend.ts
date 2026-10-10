// "Blocca invio": un invio ancora in coda torna bozza e si apre nel compositore.

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { DraftDto } from '@mmw/shared';
import { api } from '../api.ts';
import { paths, SYSTEM_INBOX } from '../shell/paths.ts';
import { useToast } from '../ui/toast.tsx';

export function useBlockSend() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const open = (d: DraftDto) => {
    for (const k of [['activities'], ['conversations'], ['counts'], ['projects'], ['drafts']]) qc.invalidateQueries({ queryKey: k });
    if (d.conversationId) qc.invalidateQueries({ queryKey: ['conversation', d.conversationId] });
    const project = d.projectId ?? SYSTEM_INBOX;
    navigate(d.conversationId ? paths.draft(project, d.conversationId, d.id) : paths.newMail(project, d.id));
    toast({ text: 'Invio bloccato: la mail è tornata in bozza' });
  };
  const fail = (err: unknown) => toast({ text: (err as Error).message });
  return {
    byActivity: (activityId: string) => api.blockActivity(activityId).then(open, fail),
    byMessage: (messageId: string) => api.blockSend(messageId).then(open, fail),
  };
}
