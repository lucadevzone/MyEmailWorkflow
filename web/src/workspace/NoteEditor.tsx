import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { longDate } from '../lib/format.ts';
import { button, input, primary } from '../ui/styles.ts';
import type { PaneAction } from './pane.ts';

/** Visualizza/modifica una nota di conversazione (noteId null = nuova). */
export function NoteEditor({ conversationId, noteId, pane }: { conversationId: string; noteId: string | null; pane: PaneAction }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.conversation(conversationId) });
  const note = noteId ? data?.notes.find((n) => n.id === noteId) : undefined;
  const [body, setBody] = useState<string | null>(null);
  const value = body ?? note?.body ?? '';
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
  };

  const save = useMutation({
    mutationFn: () => (noteId ? api.updateNote(noteId, value) : api.createNote(conversationId, value)),
    onSuccess: (n) => {
      refresh();
      setBody(null);
      if (!noteId) pane.openNote(conversationId, n.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteNote(noteId!),
    onSuccess: () => {
      refresh();
      pane.close();
    },
  });

  if (noteId && data && !note) return <div className="p-6 text-sm text-stone-500">Nota non trovata.</div>;

  return (
    <div className="flex h-full flex-col gap-3 p-6">
      <div>
        <h2 className="text-lg font-semibold">{noteId ? 'Nota' : 'Nuova nota'}</h2>
        <p className="text-xs text-stone-500">
          {data?.subject ?? ''}
          {note && <> · modificata {longDate(note.updatedAt)}</>}
        </p>
      </div>
      <textarea
        className={`${input} min-h-0 flex-1 bg-amber-50/60 leading-relaxed dark:bg-amber-950/20`}
        value={value}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Scrivi una nota personale su questa conversazione…"
        autoFocus
      />
      {(save.error || remove.error) && <div className="text-sm text-rose-600">{((save.error || remove.error) as Error).message}</div>}
      <div className="flex gap-2">
        {noteId && (
          <button className={button} onClick={() => confirm('Eliminare la nota?') && remove.mutate()}>
            Elimina
          </button>
        )}
        <div className="flex-1" />
        <button className={button} onClick={pane.close}>
          Chiudi
        </button>
        <button className={primary} disabled={!value.trim() || body === null || save.isPending} onClick={() => save.mutate()}>
          Salva
        </button>
      </div>
    </div>
  );
}
