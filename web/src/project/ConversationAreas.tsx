// Le due sezioni della conversazione in focus (UI v2): "Task e note" (pillole verdi e gialle) e "Risorse"
// (allegati con le versioni in linea, file della conversazione e del progetto). Si comprimono con un clic
// sull'etichetta; lo stato resta per le prossime aperture.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, FileText, Mail, Paperclip, StickyNote, Trash2 } from 'lucide-react';
import type { ConversationDetail, ConversationListItem, FileDto, NoteDto, ResourceDto, TaskDto } from '@mmw/shared';
import { api } from '../api.ts';
import { fileSize, personLabel, shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useMenuAt } from '../ui/contextMenu.tsx';
import { useConfirm } from '../ui/confirm.tsx';
import { useToast } from '../ui/toast.tsx';
import type { TagEditorTarget } from './TagEditor.tsx';

type OpenEditor = (e: { target: TagEditorTarget; anchor: DOMRect }) => void;

/** Stato compresso/esteso di un'area, ricordato nel browser (vale per tutte le conversazioni). */
function useCollapsed(key: string): [boolean, () => void] {
  const storageKey = `mmw.area.${key}.collapsed`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem(storageKey, v ? '0' : '1');
      } catch {
        /* storage non disponibile: resta solo in memoria */
      }
      return !v;
    });
  return [collapsed, toggle];
}

function SectionHead({ label, count, collapsed, onToggle }: { label: string; count?: number | string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="pm-section__head" onClick={onToggle} aria-expanded={!collapsed} title={collapsed ? 'Espandi' : 'Comprimi'}>
      <span className="pm-label">{label}{collapsed && count !== undefined ? ` · ${count}` : ''}</span>
      <Ic icon={ChevronDown} size={13} className={`pm-section__chevron${collapsed ? ' pm-section__chevron--closed' : ''}`} />
    </button>
  );
}

const noteTitleOf = (n: NoteDto) => n.body.split('\n').find((l) => l.trim() && !l.startsWith('>')) ?? n.body.split('\n')[0] ?? '';

export function TaskNotesSection({ c, d, tasks, loading, canRemind, onRemind, onEditor, onOpenMessage, onChanged }: {
  c: ConversationListItem;
  d?: ConversationDetail;
  tasks: TaskDto[];
  loading: boolean;
  canRemind: boolean;
  onRemind: () => void;
  onEditor: OpenEditor;
  onOpenMessage: (messageId: string) => void;
  onChanged: () => void;
}) {
  const menuAt = useMenuAt();
  const ask = useConfirm();
  const [collapsed, toggle] = useCollapsed('tasks');
  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const notes = d?.notes ?? [];
  const projectId = c.projectId;
  const edit = (task: TaskDto | undefined, anchor: DOMRect) => {
    if (projectId) onEditor({ target: { kind: 'task', task, projectId, conversationId: c.id }, anchor });
  };
  const editNote = (note: NoteDto | undefined, anchor: DOMRect) => onEditor({ target: { kind: 'note', note, conversationId: c.id }, anchor });
  const rectOf = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();

  return (
    <section
      className="pm-section"
      aria-label="Task e note"
      onContextMenu={(e) => {
        const anchor = rectOf(e);
        menuAt(() => ({
          title: 'Task e note',
          actions: [
            ...(projectId ? [{ id: 'new', icon: 'add_task', label: 'Nuovo task', primary: true, run: () => edit(undefined, anchor) }] : []),
            { id: 'note', icon: 'note_add', label: 'Nuova nota', primary: true, run: () => editNote(undefined, anchor) },
            ...(canRemind ? [{ id: 'remind', icon: 'reply', label: 'Ricordami di rispondere', primary: true, run: onRemind }] : []),
          ],
        }))(e);
      }}
    >
      <SectionHead label={projectId ? 'Task e note' : 'Note'} count={(loading ? c.taskCount : open.length) + notes.length} collapsed={collapsed} onToggle={toggle} />
      {!collapsed && (
        <div className="pm-tags">
          {open.map((t) => (
            <button key={t.id} type="button" className="pm-tag pm-tag--task" title={t.details ?? t.title} aria-label={`Modifica task: ${t.title}`}
              onClick={(e) => edit(t, rectOf(e))}
              onContextMenu={(e) => {
                const anchor = rectOf(e);
                menuAt(() => ({
                  title: t.title,
                  actions: [
                    { id: 'edit', icon: 'edit', label: 'Modifica', primary: true, run: () => edit(t, anchor) },
                    { id: 'done', icon: 'task_alt', label: 'Task terminato', primary: true, run: async () => (await ask({ message: 'Segnare il task come terminato?', okLabel: 'Sì, terminato' })) && api.updateTask(t.id, { status: 'done' }).then(onChanged) },
                    ...(t.messageId ? [{ id: 'mail', icon: 'mail', label: 'Vai alla mail', primary: true, run: () => onOpenMessage(t.messageId!) }] : []),
                    { id: 'del', icon: 'delete', label: 'Elimina', tone: 'danger' as const, run: async () => (await ask({ message: 'Eliminare il task?', okLabel: 'Elimina', danger: true })) && api.deleteTask(t.id).then(onChanged) },
                  ],
                }))(e);
              }}>
              <span className="pm-tag__text">{t.title}</span>
              {t.messageId && <Ic icon={Mail} size={12} className="pm-tag__source" label="nato da una mail" />}
            </button>
          ))}
          {done.map((t) => (
            <button key={t.id} type="button" className="pm-tag pm-tag--task pm-tag--done" title={`Terminato: ${t.title}`} aria-label={`Task terminato: ${t.title}`}
              onClick={(e) => edit(t, rectOf(e))}
              onContextMenu={menuAt(() => ({
                title: t.title,
                actions: [
                  { id: 'reopen', icon: 'undo', label: 'Riapri', primary: true, run: () => void api.updateTask(t.id, { status: 'open' }).then(onChanged) },
                  ...(t.messageId ? [{ id: 'mail', icon: 'mail', label: 'Vai alla mail', primary: true, run: () => onOpenMessage(t.messageId!) }] : []),
                  { id: 'del', icon: 'delete', label: 'Elimina', tone: 'danger' as const, run: async () => (await ask({ message: 'Eliminare il task?', okLabel: 'Elimina', danger: true })) && api.deleteTask(t.id).then(onChanged) },
                ],
              }))}>
              <span className="pm-tag__text">{t.title}</span>
            </button>
          ))}
          {notes.map((n) => (
            <button key={n.id} type="button" className="pm-tag pm-tag--note" title={n.body} aria-label={`Modifica nota: ${noteTitleOf(n)}`}
              onClick={(e) => editNote(n, rectOf(e))}
              onContextMenu={(e) => {
                const anchor = rectOf(e);
                menuAt(() => ({
                  title: 'Nota',
                  actions: [
                    { id: 'edit', icon: 'edit', label: 'Modifica', primary: true, run: () => editNote(n, anchor) },
                    ...(n.messageId ? [{ id: 'mail', icon: 'mail', label: 'Vai alla mail', primary: true, run: () => onOpenMessage(n.messageId!) }] : []),
                    { id: 'del', icon: 'delete', label: 'Elimina', tone: 'danger' as const, run: async () => (await ask({ message: 'Eliminare la nota?', okLabel: 'Elimina', danger: true })) && api.deleteNote(n.id).then(onChanged) },
                  ],
                }))(e);
              }}>
              <Ic icon={StickyNote} size={13} />
              <span className="pm-tag__text">{noteTitleOf(n)}</span>
            </button>
          ))}
          {projectId && (
            <button type="button" className="pm-addpill pm-addpill--task" onClick={(e) => edit(undefined, rectOf(e))}>
              + task
            </button>
          )}
          <button type="button" className="pm-addpill pm-addpill--note" onClick={(e) => editNote(undefined, rectOf(e))}>
            + nota
          </button>
        </div>
      )}
    </section>
  );
}

/** Scarica un file come farebbe un clic sul link. */
function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.click();
}

export function ResourcesSection({ c, d, onOpenMessage, onUpload }: {
  c: ConversationListItem;
  d?: ConversationDetail;
  onOpenMessage: (messageId: string) => void;
  onUpload: () => void;
}) {
  const qc = useQueryClient();
  const menuAt = useMenuAt();
  const ask = useConfirm();
  const toast = useToast();
  const [collapsed, toggle] = useCollapsed('resources');
  const [history, setHistory] = useState<string | null>(null);
  const files = d?.files ?? [];
  const own = d?.resources ?? [];
  // Comuni a tutto il progetto: si gestiscono da "Modifica progetto".
  const { data: projectRes = [] } = useQuery({ queryKey: ['project-resources', c.projectId], queryFn: () => api.projectResources(c.projectId!), enabled: !!c.projectId });
  const common = projectRes.filter((r) => !r.conversationId);
  const total = files.length + own.length + common.length;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['conversation', c.id] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
  };
  const removeRes = useMutation({ mutationFn: api.deleteResource, onSuccess: refresh });
  const toResource = useMutation({
    mutationFn: (attachmentId: string) => api.attachmentToResource(attachmentId),
    onSuccess: () => {
      refresh();
      toast({ text: 'Salvato tra i file' });
    },
  });
  const attachmentRow = (f: FileDto) => {
    const versioned = f.versions.length > 1;
    // Ricevuto più volte: nuove versioni o lo stesso contenuto rimandato (anche con un altro nome, es. "(1)").
    const arrivals = f.versions.reduce((n, v) => n + 1 + v.resent.length, 0);
    const lastArrival = Math.max(...f.versions.flatMap((v) => [v.date, ...v.resent.map((r) => r.date)]));
    const hasHistory = arrivals > 1;
    const openHistory = history === f.key;
    return (
      <div key={f.key}>
        <div className="pm-res"
          onContextMenu={menuAt(() => ({
            title: f.name,
            actions: [
              { id: 'dl', icon: 'download', label: 'Scarica', primary: true, run: () => download(`/api/attachments/${f.latest.attachmentId}`) },
              { id: 'mail', icon: 'mail', label: 'Vai alla mail', primary: true, run: () => onOpenMessage(f.latest.messageId) },
              ...(hasHistory ? [{ id: 'hist', icon: 'history', label: versioned ? 'Versioni precedenti' : 'Storia degli invii', primary: true, run: () => setHistory(f.key) }] : []),
              { id: 'res', icon: 'create_new_folder', label: 'Salva tra i file', run: () => toResource.mutate(f.latest.attachmentId) },
            ],
          }))}>
          <Ic icon={Paperclip} size={16} className="pm-res__icon" label="Allegato" />
          <a className="pm-res__main" href={`/api/attachments/${f.latest.attachmentId}`} title={versioned ? `Scarica l'ultima versione (v${f.latest.no})` : 'Scarica'}>
            <span className="pm-res__name pm-truncate">{f.name}</span>
            <span className="pm-res__meta">
              {f.latest.from ? personLabel(f.latest.from) : '—'} · {shortDate(f.latest.date)} · {fileSize(f.latest.size)}
              {lastArrival > f.latest.date && <> · rinviato {shortDate(lastArrival)}</>}
            </span>
          </a>
          {hasHistory && (
            <button type="button" className={`pm-res__versions${openHistory ? ' pm-res__versions--open' : ''}`} aria-expanded={openHistory}
              title={versioned ? `${f.versions.length} versioni: mostra le precedenti` : `Ricevuto ${arrivals} volte, stesso contenuto: mostra gli invii`}
              onClick={() => setHistory(openHistory ? null : f.key)}>
              <Icon name="file_copy" size={14} /> {versioned ? f.versions.length : arrivals}
            </button>
          )}
        </div>
        {openHistory && (
          <ol className="pm-versions" aria-label={`Versioni di ${f.name}`}>
            {f.versions.map((v) => (
              <li key={v.attachmentId}>
                <div className="pm-version">
                  <span className="pm-truncate"><strong>v{v.no}</strong> {shortDate(v.date)} · {v.from ? personLabel(v.from) : '—'} · {fileSize(v.size)}</span>
                  <button type="button" className="pm-res__action" title="Apri la mail di questa versione" onClick={() => onOpenMessage(v.messageId)}>
                    <Ic icon={Mail} size={14} />
                  </button>
                  <a className="pm-res__action" href={`/api/attachments/${v.attachmentId}`} title={`Scarica v${v.no}`}>
                    <Ic icon={Download} size={14} />
                  </a>
                </div>
                {v.resent.map((r) => (
                  <button key={r.attachmentId} type="button" className="pm-version__resent" onClick={() => onOpenMessage(r.messageId)} title="Apri la mail">
                    stesso contenuto rinviato da {r.from ? personLabel(r.from) : '—'} · {shortDate(r.date)}
                    {r.filename && r.filename !== v.filename && <> · come «{r.filename}»</>}
                  </button>
                ))}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  };

  const fileRow = (r: ResourceDto, shared: boolean) => (
    <div key={r.id} className="pm-res" title={shared ? 'File comune del progetto (si gestisce da Modifica progetto)' : undefined}
      onContextMenu={menuAt(() => ({
        title: r.title,
        actions: [
          { id: 'dl', icon: 'download', label: 'Scarica', primary: true, run: () => download(`/api/resources/${r.id}`) },
          ...(shared ? [] : [{ id: 'del', icon: 'delete', label: 'Elimina', tone: 'danger' as const, run: async () => (await ask({ message: `Eliminare ${r.title}?`, okLabel: 'Elimina', danger: true })) && removeRes.mutate(r.id) }]),
        ],
      }))}>
      <Ic icon={FileText} size={16} className="pm-res__icon" label={shared ? 'File del progetto' : 'File'} />
      <a className="pm-res__main" href={`/api/resources/${r.id}`}>
        <span className="pm-res__name pm-truncate">{r.title}</span>
        <span className="pm-res__meta">{shared ? 'file del progetto' : `file · ${shortDate(r.createdAt)}`}{r.size != null ? ` · ${fileSize(r.size)}` : ''}</span>
      </a>
      {!shared && (
        <button type="button" className="pm-res__action" title="Elimina" onClick={async () => (await ask({ message: `Eliminare ${r.title}?`, okLabel: 'Elimina', danger: true })) && removeRes.mutate(r.id)}>
          <Ic icon={Trash2} size={14} />
        </button>
      )}
    </div>
  );

  return (
    <section
      className="pm-section"
      aria-label="Risorse"
      onContextMenu={(e) => {
        menuAt(() => ({
          title: 'Risorse',
          actions: [
            { id: 'up', icon: 'upload_file', label: 'Carica file', primary: true, run: onUpload },
            ...(files.length ? [{ id: 'all', icon: 'create_new_folder', label: 'Salva tutti gli allegati tra i file', run: () => files.forEach((f) => toResource.mutate(f.latest.attachmentId)) }] : []),
          ],
        }))(e);
      }}
    >
      <SectionHead label="Risorse" count={d ? total : '…'} collapsed={collapsed} onToggle={toggle} />
      {!collapsed && (
        <div className="pm-res__list">
          {files.map(attachmentRow)}
          {own.map((r) => fileRow(r, false))}
          {common.map((r) => fileRow(r, true))}
          <div>
            <button type="button" className="pm-addpill pm-addpill--file" onClick={onUpload}>
              + carica file
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
