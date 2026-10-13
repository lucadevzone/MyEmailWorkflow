import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar, GripVertical, Mail, Plus, Sparkles, X } from 'lucide-react';
import type { TaskDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useContextMenu, type MenuAction } from '../ui/contextMenu.tsx';
import { dueInfo, useTaskOps } from '../tasks/useTaskOps.ts';
import { paths, SYSTEM_INBOX } from '../shell/paths.ts';
import { TagEditor, type TagEditorTarget } from './TagEditor.tsx';
import { useConfirm } from '../ui/confirm.tsx';

/**
 * Pannello dei task del progetto (D9, a comparsa nella UI v2): task di tutte le conversazioni più quelli
 * del progetto. projectId "inbox" = Da smistare, che ha la sua lista come un progetto.
 */
export function TasksSidebar({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const scope = projectId === SYSTEM_INBOX ? null : projectId;
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks', 'project', projectId], queryFn: () => api.projectTasks(projectId) });
  const ops = useTaskOps();
  const ask = useConfirm();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [title, setTitle] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ target: TagEditorTarget; anchor: DOMRect } | null>(null);
  // Durante il trascinamento la lista mostra già il nuovo ordine (UI v2: niente segnaposto).
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const grabbing = useRef<string | null>(null);
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const list = tab === 'open' ? (drag ? drag.order.map((id) => open.find((t) => t.id === id)).filter((t): t is TaskDto => !!t) : open) : done;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) ops.create.mutate({ projectId: scope, title }, { onSuccess: () => setTitle('') });
  };
  const moveBy = (t: TaskDto, delta: -1 | 1) => {
    const i = open.findIndex((x) => x.id === t.id);
    const rest = open.filter((x) => x.id !== t.id);
    const j = Math.max(0, Math.min(rest.length, i + delta));
    ops.move.mutate({ id: t.id, afterId: j === 0 ? null : rest[j - 1]!.id });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (drag) {
      const i = drag.order.indexOf(drag.id);
      if (drag.order.join() !== open.map((t) => t.id).join()) ops.move.mutate({ id: drag.id, afterId: i === 0 ? null : drag.order[i - 1]! });
    }
    setDrag(null);
  };

  return (
    <aside className="pm-tasks" aria-label="Task del progetto">
      <div className="pm-tasks__head">
        <span className="pm-tasks__title">{scope ? 'Task del progetto' : 'Task di Da smistare'}</span>
        <span className="pm-seg" role="radiogroup" aria-label="Stato dei task">
          <button type="button" role="radio" className="pm-seg__opt" aria-checked={tab === 'open'} onClick={() => setTab('open')}>
            Aperti · {open.length}
          </button>
          <button type="button" role="radio" className="pm-seg__opt" aria-checked={tab === 'done'} onClick={() => setTab('done')}>
            Terminati · {done.length}
          </button>
        </span>
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Chiudi i task del progetto" title="Chiudi" onClick={onClose}>
          <Ic icon={X} size={15} />
        </button>
      </div>
      <div className="pm-tasks__body">
        {tab === 'open' && (
          <form className="pm-tasks__new" onSubmit={submit}>
            <Ic icon={Plus} size={15} />
            <input placeholder={scope ? 'Nuovo task del progetto' : 'Nuovo task'} aria-label={scope ? 'Nuovo task del progetto' : 'Nuovo task di Da smistare'} value={title} onChange={(e) => setTitle(e.target.value)} />
          </form>
        )}
        {list.length === 0 && <div className="pm-empty">{tab === 'open' ? 'Nessun task aperto.' : 'Nessun task terminato.'}</div>}
        {list.map((t) => (
          <TaskItem
            key={t.id}
            t={t}
            open={expanded === t.id}
            onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
            onEdit={(anchor) => setEditor({ target: { kind: 'task', task: t, projectId: scope, conversationId: t.conversationId }, anchor })}
            onClose={async () => (t.status !== 'open' || (await ask({ message: 'Segnare il task come terminato?', okLabel: 'Sì, terminato' }))) && ops.update.mutate({ id: t.id, patch: { status: t.status === 'open' ? 'done' : 'open' } })}
            onMove={tab === 'open' ? (d) => moveBy(t, d) : undefined}
            drag={
              tab === 'open'
                ? {
                    state: drag,
                    onGrab: () => (grabbing.current = t.id),
                    onStart: (e) => {
                      if (grabbing.current !== t.id) return e.preventDefault();
                      e.dataTransfer.effectAllowed = 'move';
                      setDrag({ id: t.id, order: open.map((x) => x.id) });
                    },
                    onOver: (e) => {
                      if (!drag) return;
                      e.preventDefault();
                      if (t.id === drag.id) return;
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const after = e.clientY > r.top + r.height / 2;
                      const rest = drag.order.filter((x) => x !== drag.id);
                      const i = rest.indexOf(t.id);
                      rest.splice(after ? i + 1 : i, 0, drag.id);
                      if (rest.join() !== drag.order.join()) setDrag({ ...drag, order: rest });
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
      <SuggestedTasks projectId={projectId} />
      {editor && <TagEditor target={editor.target} anchor={editor.anchor} onClose={() => setEditor(null)} />}
    </aside>
  );
}

/** Task suggeriti dall'assistente nelle conversazioni del progetto: fissi in fondo, uno alla volta. */
function SuggestedTasks({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { data: suggestions = [] } = useQuery({ queryKey: ['task-suggestions', projectId], queryFn: () => api.projectTaskSuggestions(projectId) });
  const [busy, setBusy] = useState(false);
  const s = suggestions[0];
  if (!s) return null;
  const p = s.payload as { title?: string; dueDate?: string | null };
  const run = async (accept: boolean) => {
    setBusy(true);
    try {
      await (accept ? api.acceptSuggestion(s.id) : api.rejectSuggestion(s.id));
      for (const k of [['task-suggestions', projectId], ['tasks'], ['conversations'], ['projects']]) await qc.invalidateQueries({ queryKey: k });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pm-drawer__foot">
      <div className="pm-suggtask">
        <div className="pm-label pm-label--sugg">
          <Ic icon={Sparkles} size={13} /> Suggerito dall'assistente{suggestions.length > 1 ? ` · 1 di ${suggestions.length}` : ''}
        </div>
        <div className="pm-suggtask__title">{p.title}</div>
        {s.conversationTitle && <div className="pm-suggtask__from pm-truncate">da: {s.conversationTitle}</div>}
        <div className="pm-suggtask__actions">
          <button type="button" className="pm-btn pm-btn--sugg pm-btn--sm" disabled={busy} onClick={() => void run(true)}>Accetta</button>
          <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" disabled={busy} onClick={() => void run(false)}>Ignora</button>
        </div>
      </div>
    </div>
  );
}

interface DragProps {
  state: { id: string; order: string[] } | null;
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
      { id: 'close', icon: t.status === 'open' ? 'task_alt' : 'undo', label: t.status === 'open' ? 'Task terminato' : 'Riapri', primary: true, run: onClose },
      ...(onMove
        ? [
            { id: 'up', icon: 'arrow_upward', label: 'Sposta su', run: () => onMove(-1) },
            { id: 'down', icon: 'arrow_downward', label: 'Sposta giù', run: () => onMove(1) },
          ]
        : []),
    ];
    return { title: t.title, actions };
  });
  const cls = `pm-taskitem${open ? ' pm-taskitem--open' : ''}${t.status === 'done' ? ' pm-taskitem--closed' : ''}${drag?.state?.id === t.id ? ' pm-dragging' : ''}`;

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
            {t.conversationId && (
              <button type="button" className="pm-infochip" onClick={() => navigate(paths.conversation(t.projectId ?? SYSTEM_INBOX, t.conversationId!))}>
                <span className="pm-truncate" style={{ maxWidth: 220 }}>{t.conversationSubject ?? 'Conversazione'}</span>
              </button>
            )}
            {t.messageId && t.conversationId && (
              <button type="button" className="pm-infochip" onClick={() => navigate(paths.message(t.projectId ?? SYSTEM_INBOX, t.conversationId!, t.messageId!))} title="Apri la mail da cui è nato">
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
              {t.status === 'open' ? 'Task terminato' : 'Riapri'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
