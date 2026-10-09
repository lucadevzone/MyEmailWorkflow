import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar, GripVertical, Mail, Plus } from 'lucide-react';
import type { TaskDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useContextMenu, type MenuAction } from '../ui/contextMenu.tsx';
import { dueInfo, useTaskOps } from '../tasks/useTaskOps.ts';
import { paths } from '../shell/paths.ts';
import { TagEditor, type TagEditorTarget } from './TagEditor.tsx';

/** Barra dei task del progetto (D9): task di tutte le conversazioni più quelli del progetto. */
export function TasksSidebar({ projectId }: { projectId: string }) {
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks', 'project', projectId], queryFn: () => api.projectTasks(projectId) });
  const ops = useTaskOps();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [title, setTitle] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ target: TagEditorTarget; anchor: DOMRect } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const grabbing = useRef<string | null>(null);
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const list = tab === 'open' ? open : done;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) ops.create.mutate({ projectId, title }, { onSuccess: () => setTitle('') });
  };
  const moveBy = (t: TaskDto, delta: -1 | 1) => {
    const i = open.findIndex((x) => x.id === t.id);
    const rest = open.filter((x) => x.id !== t.id);
    const j = Math.max(0, Math.min(rest.length, i + delta));
    ops.move.mutate({ id: t.id, afterId: j === 0 ? null : rest[j - 1]!.id });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (drag?.over && drag.over !== drag.id) {
      const rest = open.filter((t) => t.id !== drag.id);
      const i = rest.findIndex((t) => t.id === drag.over);
      ops.move.mutate({ id: drag.id, afterId: drag.after ? rest[i]!.id : (rest[i - 1]?.id ?? null) });
    }
    setDrag(null);
  };

  return (
    <aside className="pm-tasks" aria-label="Task del progetto">
      <div className="pm-tasks__head">
        <span className="pm-tasks__title">Task del progetto</span>
        <span className="pm-seg" role="radiogroup" aria-label="Stato dei task">
          <button type="button" role="radio" className="pm-seg__opt" aria-checked={tab === 'open'} onClick={() => setTab('open')}>
            Aperti · {open.length}
          </button>
          <button type="button" role="radio" className="pm-seg__opt" aria-checked={tab === 'done'} onClick={() => setTab('done')}>
            Chiusi · {done.length}
          </button>
        </span>
      </div>
      <div className="pm-tasks__body">
        {tab === 'open' && (
          <form className="pm-tasks__new" onSubmit={submit}>
            <Ic icon={Plus} size={15} />
            <input placeholder="Nuovo task del progetto" aria-label="Nuovo task del progetto" value={title} onChange={(e) => setTitle(e.target.value)} />
          </form>
        )}
        {list.length === 0 && <div className="pm-empty">{tab === 'open' ? 'Nessun task aperto.' : 'Nessun task chiuso.'}</div>}
        {list.map((t) => (
          <TaskItem
            key={t.id}
            t={t}
            open={expanded === t.id}
            onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
            onEdit={(anchor) => setEditor({ target: { kind: 'task', task: t, projectId, conversationId: t.conversationId }, anchor })}
            onClose={() => ops.update.mutate({ id: t.id, patch: { status: t.status === 'open' ? 'done' : 'open' } })}
            onMove={tab === 'open' ? (d) => moveBy(t, d) : undefined}
            drag={
              tab === 'open'
                ? {
                    state: drag,
                    onGrab: () => (grabbing.current = t.id),
                    onStart: (e) => {
                      if (grabbing.current !== t.id) return e.preventDefault();
                      e.dataTransfer.effectAllowed = 'move';
                      setDrag({ id: t.id, over: null, after: false });
                    },
                    onOver: (e) => {
                      if (!drag) return;
                      e.preventDefault();
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setDrag({ ...drag, over: t.id, after: e.clientY > r.top + r.height / 2 });
                    },
                    onDrop,
                    onEnd: () => {
                      grabbing.current = null;
                      setDrag(null);
                    },
                  }
                : undefined
            }
          />
        ))}
      </div>
      {editor && <TagEditor target={editor.target} anchor={editor.anchor} onClose={() => setEditor(null)} />}
    </aside>
  );
}

interface DragProps {
  state: { id: string; over: string | null; after: boolean } | null;
  onGrab: () => void;
  onStart: (e: DragEvent) => void;
  onOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onEnd: () => void;
}

function TaskItem({ t, open, onToggle, onEdit, onClose, onMove, drag }: {
  t: TaskDto;
  open: boolean;
  onToggle: () => void;
  onEdit: (anchor: DOMRect) => void;
  onClose: () => void;
  onMove?: (delta: -1 | 1) => void;
  drag?: DragProps;
}) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const due = dueInfo(t.dueDate);
  const origin = t.conversationId ? `da: ${t.conversationSubject ?? 'conversazione'}` : 'task del progetto';
  // Alternativa da tastiera al trascinamento (specifica §3.6).
  const ctx = useContextMenu(() => {
    const actions: MenuAction[] = [
      {
        id: 'edit', icon: 'edit', label: 'Modifica', primary: true,
        run: () => {
          if (ref.current) onEdit(ref.current.getBoundingClientRect());
        },
      },
      { id: 'close', icon: t.status === 'open' ? 'task_alt' : 'undo', label: t.status === 'open' ? 'Chiudi task' : 'Riapri', primary: true, run: onClose },
      ...(onMove
        ? [
            { id: 'up', icon: 'arrow_upward', label: 'Sposta su', run: () => onMove(-1) },
            { id: 'down', icon: 'arrow_downward', label: 'Sposta giù', run: () => onMove(1) },
          ]
        : []),
    ];
    return { title: t.title, actions };
  });
  const dropCls =
    drag?.state?.over === t.id && drag.state.id !== t.id ? (drag.state.after ? ' pm-taskitem--drop-after' : ' pm-taskitem--drop-before') : '';
  const cls = `pm-taskitem${open ? ' pm-taskitem--open' : ''}${t.status === 'done' ? ' pm-taskitem--closed' : ''}${drag?.state?.id === t.id ? ' pm-taskitem--dragging' : ''}${dropCls}`;

  return (
    <div
      ref={ref}
      className={cls}
      draggable={!!drag}
      onDragStart={drag?.onStart}
      onDragOver={drag?.onOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onEnd}
      onClick={() => !open && onToggle()}
      onContextMenu={ctx.onContextMenu}
      onKeyDown={(e) => {
        ctx.onKeyDown(e);
        if (!open && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={open}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%' }}>
        {drag ? (
          <span className="pm-taskitem__grip" onPointerDown={drag.onGrab} title="Trascina per riordinare" aria-hidden="true">
            <Ic icon={GripVertical} size={15} />
          </span>
        ) : (
          <span style={{ width: 15 }} />
        )}
        <div className="pm-taskitem__main" onClick={() => open && onToggle()}>
          <div className="pm-taskitem__title">{t.title}</div>
          {!open && (
            <div className="pm-taskitem__origin">
              {origin}
              {due && <span className={due.tone === 'late' ? 'pm-due--late' : ''}> · {due.label}</span>}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div className="pm-taskitem__details">
          {t.details && <p className="pm-taskitem__desc">{t.details}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {due && (
              <span className={`pm-infochip${due.tone === 'late' ? ' pm-due--late' : ''}`} style={{ textDecoration: 'none' }}>
                <Ic icon={Calendar} size={15} /> {due.label}
              </span>
            )}
            {t.conversationId && t.projectId && (
              <button type="button" className="pm-infochip" onClick={() => navigate(paths.conversation(t.projectId!, t.conversationId!))}>
                <span className="pm-truncate" style={{ maxWidth: 220 }}>{t.conversationSubject ?? 'Conversazione'}</span>
              </button>
            )}
            {t.messageId && t.conversationId && t.projectId && (
              <button type="button" className="pm-infochip" onClick={() => navigate(paths.message(t.projectId!, t.conversationId!, t.messageId!))} title="Apri la mail da cui è nato">
                <Ic icon={Mail} size={15} /> dalla mail
              </button>
            )}
            {!t.conversationId && <span className="pm-infochip" style={{ textDecoration: 'none' }}>task del progetto</span>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={(e) => onEdit((e.currentTarget as HTMLElement).getBoundingClientRect())}>
              Modifica
            </button>
            <button type="button" className={`pm-btn pm-btn--sm ${t.status === 'open' ? 'pm-btn--success' : 'pm-btn--secondary'}`} onClick={onClose}>
              {t.status === 'open' ? 'Chiudi task' : 'Riapri'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
