// RF-C5: staccare un messaggio (e le sue risposte) in una nuova conversazione, con conferma e annulla.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { MenuAction } from '../ui/contextMenu.tsx';
import { api } from '../api.ts';
import { paths, SYSTEM_INBOX } from '../shell/paths.ts';
import { useConfirm } from '../ui/confirm.tsx';
import { useToast } from '../ui/toast.tsx';

export function useDetach() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ask = useConfirm();
  const toast = useToast();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const refresh = (ids: string[]) => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['tasks']]) qc.invalidateQueries({ queryKey: k });
    for (const id of ids) qc.invalidateQueries({ queryKey: ['conversation', id] });
  };

  const rejoin = async (conversationId: string, projectKey: string) => {
    try {
      const r = await api.rejoinConversation(conversationId);
      refresh([r.conversationId, conversationId]);
      navigate(paths.conversation(projectKey, r.conversationId));
      toast({ text: 'Conversazioni riunite' });
    } catch (err) {
      toast({ text: (err as Error).message });
    }
  };

  /** projectId: undefined = stesso progetto, null = Da smistare. withReplies: anche il ramo delle risposte. */
  const detach = async (messageId: string, currentProjectId: string | null, projectId?: string | null, withReplies = true) => {
    const where = projectId === undefined ? '' : projectId === null ? ' in Da smistare' : ` in ${projects.find((p) => p.id === projectId)?.name ?? 'progetto'}`;
    const ok = await ask({
      message: `Staccare ${withReplies ? 'questa mail e le sue risposte' : 'solo questa mail'} in una nuova conversazione${where}? Le risposte future seguiranno il ramo giusto.`,
      okLabel: 'Stacca',
    });
    if (!ok) return;
    try {
      const r = await api.detachMessage(messageId, projectId, withReplies);
      refresh([r.conversationId, r.fromConversationId]);
      const target = projectId === undefined ? currentProjectId : projectId;
      const key = target ?? SYSTEM_INBOX;
      navigate(paths.conversation(key, r.conversationId));
      toast({
        text: r.moved === 1 ? 'Messaggio staccato in una nuova conversazione' : `${r.moved} messaggi staccati in una nuova conversazione`,
        action: { label: 'Annulla', run: () => void rejoin(r.conversationId, currentProjectId ?? SYSTEM_INBOX) },
      });
    } catch (err) {
      toast({ text: (err as Error).message });
    }
  };

  /** Voci di menu per un messaggio: la prima nella barra, le destinazioni nella palette ("Altro"). */
  const menuActions = (messageId: string, currentProjectId: string | null, replies = 0): MenuAction[] => [
    ...(replies > 0
      ? [
          { id: 'detach', icon: 'call_split', label: `Stacca con le risposte (${replies + 1} mail)`, primary: true, run: () => detach(messageId, currentProjectId) },
          { id: 'detach-one', icon: 'call_split', label: 'Stacca solo questa mail', primary: true, run: () => detach(messageId, currentProjectId, undefined, false) },
        ]
      : [{ id: 'detach', icon: 'call_split', label: 'Stacca in una nuova conversazione', primary: true, run: () => detach(messageId, currentProjectId) }]),
    ...(currentProjectId ? [{ id: 'detach-inbox', icon: 'call_split', label: 'Stacca e sposta in Da smistare', run: () => detach(messageId, currentProjectId, null) }] : []),
    ...projects
      .filter((p) => !p.archived && p.id !== currentProjectId)
      .map((p) => ({ id: `detach-${p.id}`, icon: 'call_split', label: `Stacca e sposta in ${p.name}`, run: () => detach(messageId, currentProjectId, p.id) })),
  ];

  return { detach, rejoin, menuActions };
}
