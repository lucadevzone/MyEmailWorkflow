import { useState, type DragEvent, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { input, primary } from '../ui/styles.ts';
import { dueCls, dueInfo, useTaskOps } from './useTaskOps.ts';
import type { TaskDraft } from '../workspace/pane.ts';

/** Pannello dei task del progetto: coda riordinabile col trascinamento, completati in fondo. */
export function TasksPanel({ projectId, draft, onOpenConversation }: {
  projectId: string;
  /** Nuovo task da un messaggio: il titolo va scritto, il collegamento è già fatto. */
  draft?: TaskDraft;
  onOpenConversation: (conversationId: string, messageId: string | null) => void;
}) {
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks', 'project', projectId], queryFn: () => api.projectTasks(projectId) });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const ops = useTaskOps();
  const [title, setTitle] = useState(draft?.title ?? '');
  const [link, setLink] = useState(draft ?? null);
  const [due, setDue] = useState('');
  const [top, setTop] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    ops.create.mutate(
      { projectId, title, dueDate: due || null, top, conversationId: link?.conversationId, messageId: link?.messageId },
      { onSuccess: () => { setTitle(''); setDue(''); setTop(false); setLink(null); } },
    );
  };

  const onDragOver = (e: DragEvent, t: TaskDto) => {
    if (!drag) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDrag({ ...drag, over: t.id, after: e.clientY > r.top + r.height / 2 });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (!drag?.over || drag.over === drag.id) return setDrag(null);
    const rest = open.filter((t) => t.id !== drag.id);
    const i = rest.findIndex((t) => t.id === drag.over);
    const afterId = drag.after ? rest[i]!.id : (rest[i - 1]?.id ?? null);
    ops.move.mutate({ id: drag.id, afterId });
    setDrag(null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-stone-200 px-6 py-4 dark:border-stone-800">
        <h2 className="text-lg font-semibold">Task · {projects.find((p) => p.id === projectId)?.name}</h2>
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
          <input className={`${input} min-w-48 flex-1`} placeholder={link ? 'Nuovo task dal messaggio…' : 'Nuovo task…'} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!!link} />
          <input className={`${input} w-40`} type="date" value={due} onChange={(e) => setDue(e.target.value)} title="Scadenza (facoltativa)" />
          <label className="flex items-center gap-1 text-xs text-stone-600 dark:text-stone-300">
            <input type="checkbox" checked={top} onChange={(e) => setTop(e.target.checked)} /> in cima
          </label>
          <button className={primary} disabled={!title.trim() || ops.create.isPending}>
            Aggiungi
          </button>
        </form>
        {link && (
          <div className="mt-1 flex items-center gap-1 text-xs text-stone-500">
            <Icon name="link" size={14} /> collegato al messaggio
            <button className="underline" onClick={() => setLink(null)}>scollega</button>
          </div>
        )}
        {ops.create.error && <div className="mt-1 text-xs text-rose-600">{(ops.create.error as Error).message}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {open.length === 0 && <p className="px-2 text-sm text-stone-500">Nessun task aperto.</p>}
        <ul onDragLeave={() => drag && setDrag({ ...drag, over: null })}>
          {open.map((t) => (
            <li
              key={t.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                setDrag({ id: t.id, over: null, after: false });
              }}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => onDragOver(e, t)}
              onDrop={onDrop}
              className={`border-y-2 ${drag?.over === t.id ? (drag.after ? 'border-b-sky-500 border-t-transparent' : 'border-t-sky-500 border-b-transparent') : 'border-transparent'} ${drag?.id === t.id ? 'opacity-40' : ''}`}
            >
              <TaskRow t={t} onOpenConversation={onOpenConversation} />
            </li>
          ))}
        </ul>
        {done.length > 0 && (
          <div className="mt-4">
            <button className="px-2 text-xs text-stone-500 hover:underline" onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Nascondi' : 'Mostra'} completati ({done.length})
            </button>
            {showDone && (
              <ul className="mt-1 opacity-70">
                {done.map((t) => (
                  <li key={t.id}>
                    <TaskRow t={t} onOpenConversation={onOpenConversation} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function TaskRow({ t, onOpenConversation, compact = false }: { t: TaskDto; onOpenConversation?: (conversationId: string, messageId: string | null) => void; compact?: boolean }) {
  const ops = useTaskOps();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const due = dueInfo(t.dueDate);
  const isDone = t.status === 'done';

  return (
    <div className={`group flex items-center gap-2 rounded px-2 ${compact ? 'py-0.5' : 'py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800'}`}>
      {!compact && !isDone && <Icon name="drag_indicator" size={16} className="cursor-grab text-stone-300 dark:text-stone-600" />}
      <button
        onClick={() => ops.update.mutate({ id: t.id, patch: { status: isDone ? 'open' : 'done' } })}
        title={isDone ? 'Riapri' : 'Completa'}
        className={isDone ? 'text-emerald-600' : 'text-stone-400 hover:text-emerald-600'}
      >
        <Icon name={isDone ? 'check_circle' : 'radio_button_unchecked'} size={18} />
      </button>
      {editing ? (
        <input
          className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1 text-sm dark:border-stone-600"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (title.trim() && title !== t.title) ops.update.mutate({ id: t.id, patch: { title } });
            else setTitle(t.title);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate text-sm ${isDone ? 'text-stone-400 line-through' : ''}`} onDoubleClick={() => !compact && setEditing(true)} title={t.details ?? t.title}>
          {t.title}
        </span>
      )}
      {!compact && !isDone && (
        <input
          type="date"
          className={`w-[7.5rem] rounded bg-transparent text-xs ${due ? dueCls[due.tone] : 'text-stone-400 opacity-0 group-hover:opacity-100'}`}
          value={t.dueDate ?? ''}
          onChange={(e) => ops.update.mutate({ id: t.id, patch: { dueDate: e.target.value || null } })}
          title="Scadenza"
        />
      )}
      {compact && due && <span className={`shrink-0 text-xs ${dueCls[due.tone]}`}>{due.label}</span>}
      {!compact && t.conversationId && onOpenConversation && (
        <button className="shrink-0 text-stone-400 hover:text-stone-900 dark:hover:text-stone-100" title={`Apri: ${t.conversationSubject ?? 'conversazione'}`} onClick={() => onOpenConversation(t.conversationId!, t.messageId)}>
          <Icon name="mail" size={16} />
        </button>
      )}
      {!compact && (
        <button className="shrink-0 text-stone-300 opacity-0 hover:text-rose-600 group-hover:opacity-100" title="Elimina" onClick={() => ops.remove.mutate(t.id)}>
          <Icon name="delete" size={16} />
        </button>
      )}
    </div>
  );
}
