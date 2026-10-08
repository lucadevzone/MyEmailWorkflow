import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskDto, TaskInput } from '@mmw/shared';
import { api } from '../api.ts';

/** Operazioni sui task con aggiornamento di liste, conteggi e conversazioni. */
export function useTaskOps() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
  };
  return {
    create: useMutation({ mutationFn: (input: TaskInput) => api.createTask(input), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<TaskDto, 'title' | 'details' | 'dueDate' | 'status'>> }) => api.updateTask(id, patch),
      onSuccess: refresh,
    }),
    move: useMutation({ mutationFn: ({ id, afterId }: { id: string; afterId: string | null }) => api.moveTask(id, afterId), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteTask(id), onSuccess: refresh }),
  };
}

const fmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' });

/** "16 ott", con tono: scaduto (rosso), oggi/domani (ambra), altrimenti neutro. */
export function dueInfo(due: string | null): { label: string; tone: 'late' | 'soon' | 'ok' } | null {
  if (!due) return null;
  const d = new Date(`${due}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const label = days === 0 ? 'oggi' : days === 1 ? 'domani' : fmt.format(d);
  return { label, tone: days < 0 ? 'late' : days <= 1 ? 'soon' : 'ok' };
}

export const dueCls = { late: 'text-rose-600 dark:text-rose-400', soon: 'text-amber-600 dark:text-amber-400', ok: 'text-stone-500' } as const;
