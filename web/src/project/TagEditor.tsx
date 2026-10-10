import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, SquareCheck, StickyNote } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { personLabel, shortDate } from '../lib/format.ts';
import { paths, projectKeyOf } from '../shell/paths.ts';
import type { NoteDto, QuoteSelector, TaskDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useConfirm } from '../ui/confirm.tsx';

export type TagEditorTarget =
  | { kind: 'task'; task?: TaskDto; projectId: string; conversationId: string | null; messageId?: string | null; initialTitle?: string; initialBody?: string; quote?: QuoteSelector }
  | { kind: 'note'; note?: NoteDto; conversationId: string; messageId?: string | null; initialBody?: string; quote?: QuoteSelector };

/**
 * Maschera di modifica di task e note (O1): popover di 360 px ancorato all'elemento.
 * Task: titolo, descrizione, scadenza, conversazione collegata; Elimina · Chiudi task · Salva.
 */
export function TagEditor({ target, anchor, onClose }: { target: TagEditorTarget; anchor: DOMRect; onClose: () => void }) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const navigate = useNavigate();
  const ref = useRef<HTMLFormElement>(null);
  const isTask = target.kind === 'task';
  const task = isTask ? target.task : undefined;
  const note = !isTask ? target.note : undefined;
  const conversationId = target.conversationId;
  const { data: conv } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversation(conversationId!),
    enabled: !!conversationId,
  });

  const [title, setTitle] = useState(task?.title ?? (target.kind === 'task' ? (target.initialTitle ?? '') : ''));
  const [body, setBody] = useState(isTask ? (task?.details ?? target.initialBody ?? '') : (note?.body ?? target.initialBody ?? ''));
  const [due, setDue] = useState(task?.dueDate ?? '');
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 6 });

  // Sotto l'elemento se c'è spazio, altrimenti sopra; sempre dentro lo schermo.
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 320;
    const top = anchor.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, anchor.top - 6 - h) : anchor.bottom + 6;
    const left = Math.min(Math.max(8, anchor.left), window.innerWidth - 368);
    setPos({ left, top });
    ref.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus();
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = () => {
    for (const k of [['tasks'], ['conversations'], ['conversation', conversationId], ['annotations']]) qc.invalidateQueries({ queryKey: k });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (target.kind === 'task') {
        if (task) return api.updateTask(task.id, { title, details: body || null, dueDate: due || null });
        return api.createTask({ projectId: target.projectId, title, details: body || null, dueDate: due || null, conversationId, messageId: target.messageId ?? null, quote: target.messageId ? target.quote : undefined });
      }
      return note ? api.updateNote(note.id, body) : api.createNote(target.conversationId, body, target.messageId, target.quote);
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const close = useMutation({
    mutationFn: () => api.updateTask(task!.id, { status: task!.status === 'open' ? 'done' : 'open' }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => (task ? api.deleteTask(task.id) : api.deleteNote(note!.id)),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  // Fonte: la mail da cui è nato il task o la nota; un clic la apre nel carosello.
  const sourceId = isTask ? (task?.messageId ?? target.messageId ?? null) : (note?.messageId ?? (target.kind === 'note' ? target.messageId : null) ?? null);
  const source = sourceId ? conv?.messages.find((m) => m.id === sourceId) : undefined;
  const openSource = () => {
    if (!conv || !source) return;
    onClose();
    navigate(paths.message(projectKeyOf(conv), conv.id, source.id));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isTask ? title.trim() : body.trim()) save.mutate();
  };
  const editing = isTask ? !!task : !!note;
  const error = (save.error || close.error || remove.error) as Error | null;

  return (
    <>
      <div className="pm-backdrop" onPointerDown={onClose} />
      <form ref={ref} className="pm-popover" style={pos} onSubmit={submit} role="dialog" aria-label={isTask ? 'Modifica task' : 'Modifica nota'}>
        <div className="pm-popover__title" style={{ color: isTask ? 'var(--task-heading)' : 'var(--note-heading)' }}>
          <Ic icon={isTask ? SquareCheck : StickyNote} size={15} />
          {editing ? (isTask ? 'Task' : 'Nota') : isTask ? 'Nuovo task' : 'Nuova nota'}
        </div>
        {isTask && (
          <label className="pm-field">
            Titolo
            <input className="pm-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        )}
        <label className="pm-field">
          {isTask ? 'Descrizione' : 'Testo'}
          <textarea className="pm-input" rows={isTask ? 3 : 5} value={body} onChange={(e) => setBody(e.target.value)} required={!isTask} />
        </label>
        {isTask && (
          <label className="pm-field">
            Scadenza
            <input className="pm-input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        )}
        {source && conv ? (
          <div className="pm-field">
            Dalla mail
            <button type="button" className="pm-source" onClick={openSource} title="Apri la mail da cui è nato">
              <Ic icon={Mail} size={15} />
              <span className="pm-truncate">
                <strong>{source.from ? personLabel(source.from) : 'Mittente sconosciuto'}</strong> · {shortDate(source.date)} · {source.subject || conv.subject || '(nessun oggetto)'}
              </span>
            </button>
          </div>
        ) : (
          <div className="pm-field">
            Conversazione collegata
            <span style={{ color: 'var(--ink)' }} className="pm-truncate">
              {conversationId ? (conv?.summary ?? conv?.subject ?? '…') : 'nessuna · task del progetto'}
            </span>
          </div>
        )}
        {error && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-md)' }}>{error.message}</div>}
        <div className="pm-popover__actions">
          {editing && (
            <button
              type="button"
              className="pm-btn pm-btn--danger pm-btn--sm"
              onClick={async () => (await ask({ message: isTask ? 'Eliminare il task?' : 'Eliminare la nota?', okLabel: 'Elimina', danger: true })) && remove.mutate()}
            >
              Elimina
            </button>
          )}
          <span className="pm-spacer" />
          {task && (
            <button type="button" className={`pm-btn pm-btn--sm ${task.status === 'open' ? 'pm-btn--success' : 'pm-btn--secondary'}`} onClick={() => close.mutate()}>
              {task.status === 'open' ? 'Chiudi task' : 'Riapri'}
            </button>
          )}
          <button type="submit" className="pm-btn pm-btn--primary pm-btn--sm" disabled={save.isPending}>
            Salva
          </button>
        </div>
      </form>
    </>
  );
}
