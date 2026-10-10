import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Bookmark, Mail, Download, Ellipsis, FileText, FolderInput, FolderPlus, History, Paperclip, Plus, Reply, SquareCheck, StickyNote, Trash2, X } from 'lucide-react';
import type { ConversationDetail, ConversationListItem, MessageDto, SuggestionDto } from '@mmw/shared';
import { api } from '../api.ts';
import { fileSize, personLabel, shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { PeopleLine, PersonAvatar, PersonChip, useDisplayName, useMe } from '../ui/People.tsx';
import { useContextMenu, useMenuAt, useOpenMenu } from '../ui/contextMenu.tsx';
import { useConfirm } from '../ui/confirm.tsx';
import { useToast } from '../ui/toast.tsx';
import { ProjectDialog } from '../projects/ProjectDialog.tsx';
import type { ComposeRequest } from '../workspace/pane.ts';
import { TagEditor, type TagEditorTarget } from './TagEditor.tsx';
import { useConversationActions } from './useConversationActions.ts';

export interface ItemCallbacks {
  onFocus: () => void;
  onUnfocus: () => void;
  onOpenMessage: (messageId: string) => void;
  onCompose: (r: ComposeRequest) => void;
}

/** Una conversazione: compressa (D5) o in focus (D6), una sola in focus per progetto. */
export function ConversationItem({ c, focused, selectedMessageId, cb }: { c: ConversationListItem; focused: boolean; selectedMessageId: string | null; cb: ItemCallbacks }) {
  const qc = useQueryClient();
  const openMenu = useOpenMenu();
  const ref = useRef<HTMLElement>(null);
  const moveBtn = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState<{ target: TagEditorTarget; anchor: DOMRect } | null>(null);
  const [creatingFrom, setCreatingFrom] = useState<SuggestionDto | null>(null);
  const anchorOf = (el: Element | null) => el?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2, 200, 0, 0);

  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((f) => api.uploadResource(c.id, f))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', c.id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const actions = useConversationActions(c, {
    compose: cb.onCompose,
    newTask: () => c.projectId && setEditor({ target: { kind: 'task', projectId: c.projectId, conversationId: c.id }, anchor: anchorOf(ref.current) }),
    newNote: () => setEditor({ target: { kind: 'note', conversationId: c.id }, anchor: anchorOf(ref.current) }),
    uploadResource: () => fileInput.current?.click(),
    toggleFocus: focused ? cb.onUnfocus : cb.onFocus,
    openMove: () => {
      const el = moveBtn.current ?? ref.current;
      if (el) openMenu({ title: 'Sposta in', actions: actions.moveTargets() }, el as HTMLElement, 'palette');
    },
    createProjectFrom: setCreatingFrom,
  });
  const ctx = useContextMenu(() => actions.menuSpec(focused));

  const suggestions = c.suggestions.filter((s) => actions.suggestionLabel(s) && (s.kind !== 'task' || c.projectId));
  const title = c.summary ?? c.subject ?? '(nessun oggetto)';

  const extras = (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) upload.mutate(files);
        }}
      />
      {editor && <TagEditor target={editor.target} anchor={editor.anchor} onClose={() => setEditor(null)} />}
      {creatingFrom && (
        <ProjectDialog
          initialName={creatingFrom.payload.projectName}
          initialDescription={creatingFrom.payload.reason}
          onClose={() => setCreatingFrom(null)}
          onSaved={(p) => actions.runSuggestion(creatingFrom, p.id)}
        />
      )}
    </>
  );

  if (!focused) {
    return (
      <article ref={ref} className="pm-conv" data-conversation={c.id} {...ctx}>
        <button type="button" onClick={cb.onFocus} style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="pm-conv__head">
            <span className="pm-conv__title">{title}<NewBadge n={c.unreadCount} /></span>
            <span className="pm-conv__date">
              {c.hasDraft && <span className="pm-msg__draftmark">bozza</span>}
              {c.important && <Ic icon={Bookmark} size={14} className="pm-bookmark" label="Contiene messaggi importanti" />}
              {shortDate(c.lastMessageAt)}
            </span>
          </div>
          <PeopleLine people={c.participants.length ? c.participants : []} />
        </button>
        {suggestions.length > 0 && (
          <div className="pm-conv__suggestions">
            {suggestions.slice(0, 2).map((s) => (
              <SuggestionTag key={s.id} label={actions.suggestionLabel(s)!} reason={(s.payload as { reason?: string }).reason} onRun={() => actions.runSuggestion(s)} onReject={() => actions.rejectSug.mutate(s)} />
            ))}
          </div>
        )}
        {extras}
      </article>
    );
  }

  return (
    <article ref={ref} className="pm-conv pm-conv--focused" data-conversation={c.id} {...ctx}>
      <div className="pm-conv__actions" role="toolbar" aria-label="Azioni sulla conversazione">
        <button type="button" className="pm-btn pm-btn--primary" onClick={() => void actions.reply()}>
          <Ic icon={Reply} size={15} /> Rispondi
        </button>
        {c.projectId && (
          <button type="button" className="pm-btn pm-btn--ghost" onClick={(e) => setEditor({ target: { kind: 'task', projectId: c.projectId!, conversationId: c.id }, anchor: anchorOf(e.currentTarget) })}>
            <Ic icon={SquareCheck} size={15} /> Task
          </button>
        )}
        <button type="button" className="pm-btn pm-btn--ghost" onClick={(e) => setEditor({ target: { kind: 'note', conversationId: c.id }, anchor: anchorOf(e.currentTarget) })}>
          <Ic icon={StickyNote} size={15} /> Nota
        </button>
        <button type="button" className="pm-btn pm-btn--ghost" onClick={() => fileInput.current?.click()}>
          <Ic icon={FolderPlus} size={15} /> Risorsa
        </button>
        <span className="pm-conv__actions-sep" aria-hidden="true" />
        <button ref={moveBtn} type="button" className="pm-btn pm-btn--ghost" onClick={() => moveBtn.current && openMenu({ title: 'Sposta in', actions: actions.moveTargets() }, moveBtn.current, 'palette')}>
          <Ic icon={FolderInput} size={15} /> Sposta in…
        </button>
        {c.archived ? (
          <button type="button" className="pm-btn pm-btn--ghost" onClick={() => actions.unarchive.mutate()}>
            <Ic icon={ArchiveRestore} size={15} /> Ripristina
          </button>
        ) : (
          <button type="button" className="pm-btn pm-btn--danger" onClick={() => actions.archive.mutate()}>
            <Ic icon={Archive} size={15} /> Archivia
          </button>
        )}
        <button
          type="button"
          className="pm-iconbtn pm-iconbtn--sm pm-conv__more"
          aria-label="Altre azioni"
          onClick={(e) => openMenu(actions.menuSpec(true), e.currentTarget, 'palette')}
        >
          <Ic icon={Ellipsis} />
        </button>
      </div>
      <FocusedBody c={c} title={title} selectedMessageId={selectedMessageId} cb={cb} suggestions={suggestions} actions={actions} onEditor={setEditor} onUpload={() => fileInput.current?.click()} />
      {extras}
    </article>
  );
}

/** Badge dopo il titolo: messaggi arrivati e non ancora letti. */
function NewBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="pm-newbadge" title={`${n} da leggere`}>{n === 1 ? 'nuova' : `${n} nuove`}</span>;
}

function SuggestionTag({ label, reason, onRun, onReject }: { label: string; reason?: string; onRun: () => void; onReject: () => void }) {
  return (
    <span className="pm-tag pm-tag--ai" title={reason || "Suggerito dall'assistente"}>
      <button type="button" onClick={onRun} className="pm-tag__text" style={{ maxWidth: 320 }}>
        {label}
      </button>
      <button type="button" onClick={onReject} aria-label="Scarta il suggerimento">
        <Ic icon={X} size={15} />
      </button>
    </span>
  );
}

function FocusedBody({ c, title, selectedMessageId, cb, suggestions, actions, onEditor, onUpload }: {
  c: ConversationListItem;
  title: string;
  selectedMessageId: string | null;
  cb: ItemCallbacks;
  suggestions: SuggestionDto[];
  actions: ReturnType<typeof useConversationActions>;
  onEditor: (e: { target: TagEditorTarget; anchor: DOMRect }) => void;
  onUpload: () => void;
}) {
  const { data: d } = useQuery({ queryKey: ['conversation', c.id], queryFn: () => api.conversation(c.id) });
  const { data: tasks = [], isLoading: tasksLoading } = useQuery({ queryKey: ['tasks', 'conversation', c.id], queryFn: () => api.conversationTasks(c.id), enabled: !!c.projectId });
  const openTasks = tasks.filter((t) => t.status === 'open');
  const me = useMe();
  const menuAt = useMenuAt();
  const qc = useQueryClient();
  const ask = useConfirm();
  const refreshItems = () => {
    for (const k of [['tasks'], ['conversation', c.id], ['conversations']]) qc.invalidateQueries({ queryKey: k });
  };
  const rectOf = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();
  const newTask = (anchor: DOMRect) => onEditor({ target: { kind: 'task', projectId: c.projectId!, conversationId: c.id }, anchor });
  const newNote = (anchor: DOMRect) => onEditor({ target: { kind: 'note', conversationId: c.id }, anchor });
  const hasReplyTask = openTasks.some((t) => t.title.startsWith('Rispondere a '));
  const lastIn = d?.messages.filter((m) => m.direction === 'in').at(-1);
  const remindReply = () => void api.remindReply(c.id).then(refreshItems);
  const people = me ? [...c.participants, me] : c.participants;

  return (
    <div className="pm-conv__body">
      <div className="pm-conv__main">
        <div className="pm-conv__head" style={{ alignItems: 'flex-start' }}>
          <h2 className="pm-conv__title" style={{ margin: 0 }}>
            <button
              type="button"
              className="pm-conv__titlelink"
              disabled={!d?.messages.length}
              title="Apri il primo messaggio da leggere (o l'ultimo ricevuto)"
              onClick={() => {
                const id = d && entryMessage(d.messages);
                if (id) cb.onOpenMessage(id);
              }}
            >
              {title}
            </button>
            <NewBadge n={c.unreadCount} />
          </h2>
          <span className="pm-conv__date" style={{ paddingTop: 3 }}>
            {c.hasDraft && <span className="pm-msg__draftmark">bozza</span>}
            {c.important && <Ic icon={Bookmark} size={14} className="pm-bookmark" label="Contiene messaggi importanti" />}
            {shortDate(c.lastMessageAt)}
          </span>
        </div>
        <div className="pm-conv__chips">
          {people.map((p) => (
            <PersonChip key={p.email} person={p} onClick={() => cb.onCompose({ to: [p.email], projectId: c.projectId })} />
          ))}
          <span className="pm-muted" style={{ fontSize: 'var(--fs-md)' }}>· {c.messageCount} {c.messageCount === 1 ? 'messaggio' : 'messaggi'}</span>
        </div>
        {suggestions.length > 0 && (
          <div className="pm-conv__suggestions">
            {suggestions.map((s) => (
              <SuggestionTag key={s.id} label={actions.suggestionLabel(s)!} reason={(s.payload as { reason?: string }).reason} onRun={() => actions.runSuggestion(s)} onReject={() => actions.rejectSug.mutate(s)} />
            ))}
          </div>
        )}

        <div className="pm-areas">
          {c.projectId && (
            <section
              className="pm-area pm-area--task"
              aria-label="Task"
              onContextMenu={(e) => {
                const anchor = rectOf(e);
                menuAt(() => ({
                  title: 'Task',
                  actions: [
                    { id: 'new', icon: 'add_task', label: 'Nuovo task', primary: true, run: () => newTask(anchor) },
                    ...(!hasReplyTask && lastIn ? [{ id: 'remind', icon: 'reply', label: 'Ricordami di rispondere', primary: true, run: remindReply }] : []),
                  ],
                }))(e);
              }}
            >
              <h3><Ic icon={SquareCheck} size={15} /> Task · {tasksLoading ? c.taskCount : openTasks.length}</h3>
              <div className="pm-tags">
                {openTasks.map((t) => (
                  <button key={t.id} type="button" className="pm-tag pm-tag--task" title={t.details ?? t.title} aria-label={`Modifica task: ${t.title}`}
                    onClick={(e) => onEditor({ target: { kind: 'task', task: t, projectId: c.projectId!, conversationId: c.id }, anchor: e.currentTarget.getBoundingClientRect() })}
                    onContextMenu={(e) => {
                      const anchor = rectOf(e);
                      menuAt(() => ({
                        title: t.title,
                        actions: [
                          { id: 'edit', icon: 'edit', label: 'Modifica', primary: true, run: () => onEditor({ target: { kind: 'task', task: t, projectId: c.projectId!, conversationId: c.id }, anchor }) },
                          { id: 'done', icon: 'task_alt', label: 'Task terminato', primary: true, run: async () => (await ask({ message: 'Segnare il task come terminato?', okLabel: 'Sì, terminato' })) && api.updateTask(t.id, { status: 'done' }).then(refreshItems) },
                          ...(t.messageId ? [{ id: 'mail', icon: 'mail', label: 'Vai alla mail', primary: true, run: () => cb.onOpenMessage(t.messageId!) }] : []),
                          { id: 'del', icon: 'delete', label: 'Elimina', tone: 'danger' as const, run: async () => (await ask({ message: 'Eliminare il task?', okLabel: 'Elimina', danger: true })) && api.deleteTask(t.id).then(refreshItems) },
                        ],
                      }))(e);
                    }}>
                    <span className="pm-tag__text">{t.title}</span>
                    {t.messageId && <Ic icon={Mail} size={12} className="pm-tag__source" label="nato da una mail" />}
                  </button>
                ))}
                <button type="button" className="pm-tag pm-tag--task pm-tag--add"
                  onClick={(e) => onEditor({ target: { kind: 'task', projectId: c.projectId!, conversationId: c.id }, anchor: e.currentTarget.getBoundingClientRect() })}>
                  <Ic icon={Plus} size={15} /> task
                </button>
                {!hasReplyTask && lastIn && (
                  <button type="button" className="pm-tag pm-tag--task pm-tag--add" title="Crea il task «Rispondere a…»: si chiude da solo quando rispondi" onClick={remindReply}>
                    <Ic icon={Reply} size={15} /> ricordami di rispondere
                  </button>
                )}
              </div>
            </section>
          )}
          <section
            className="pm-area pm-area--note"
            aria-label="Note"
            onContextMenu={(e) => {
              const anchor = rectOf(e);
              menuAt(() => ({ title: 'Note', actions: [{ id: 'new', icon: 'note_add', label: 'Nuova nota', primary: true, run: () => newNote(anchor) }] }))(e);
            }}
          >
            <h3><Ic icon={StickyNote} size={15} /> Note · {d?.notes.length ?? c.noteCount}</h3>
            <div className="pm-tags">
              {d?.notes.map((n) => (
                <button key={n.id} type="button" className="pm-tag pm-tag--note" title={n.body} aria-label="Modifica nota"
                  onClick={(e) => onEditor({ target: { kind: 'note', note: n, conversationId: c.id }, anchor: e.currentTarget.getBoundingClientRect() })}
                  onContextMenu={(e) => {
                    const anchor = rectOf(e);
                    menuAt(() => ({
                      title: 'Nota',
                      actions: [
                        { id: 'edit', icon: 'edit', label: 'Modifica', primary: true, run: () => onEditor({ target: { kind: 'note', note: n, conversationId: c.id }, anchor }) },
                        ...(n.messageId ? [{ id: 'mail', icon: 'mail', label: 'Vai alla mail', primary: true, run: () => cb.onOpenMessage(n.messageId!) }] : []),
                        { id: 'del', icon: 'delete', label: 'Elimina', tone: 'danger' as const, run: async () => (await ask({ message: 'Eliminare la nota?', okLabel: 'Elimina', danger: true })) && api.deleteNote(n.id).then(refreshItems) },
                      ],
                    }))(e);
                  }}>
                  <Ic icon={StickyNote} size={15} className="pm-note-icon" />
                  <span className="pm-tag__text">{n.body.split('\n').find((l) => l.trim() && !l.startsWith('>')) ?? n.body.split('\n')[0]}</span>
                  {n.messageId && <Ic icon={Mail} size={12} className="pm-tag__source" label="nata da una mail" />}
                </button>
              ))}
              <button type="button" className="pm-tag pm-tag--note pm-tag--add"
                onClick={(e) => onEditor({ target: { kind: 'note', conversationId: c.id }, anchor: e.currentTarget.getBoundingClientRect() })}>
                <Ic icon={Plus} size={15} /> nota
              </button>
            </div>
          </section>
          <Attachments d={d} />
          <Resources d={d} conversationId={c.id} projectId={c.projectId} onUpload={onUpload} />
        </div>
      </div>

      <section className="pm-conv__tree" aria-label="Sintesi e messaggi della conversazione">
        <div className="pm-tree__head">Messaggi · {d?.messages.length ?? c.messageCount}</div>
        <section className="pm-summary pm-summary--side" aria-label="Sintesi">
          <div className="pm-label pm-summary__label">Sintesi</div>
          <p>{c.summaryDetailed ?? c.summary ?? 'La sintesi viene generata in background.'}</p>
        </section>
        {!d && <div className="pm-empty">Caricamento…</div>}
        {d && <MessageTree d={d} selectedId={selectedMessageId} onOpen={cb.onOpenMessage} onCompose={cb.onCompose} />}
      </section>
    </div>
  );
}

/** Scarica un file come farebbe un clic sul link. */
function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.click();
}

function Attachments({ d }: { d?: ConversationDetail }) {
  const qc = useQueryClient();
  const menuAt = useMenuAt();
  const toast = useToast();
  const [history, setHistory] = useState<string | null>(null);
  const files = d?.files ?? [];
  const toResource = useMutation({
    mutationFn: (attachmentId: string) => api.attachmentToResource(attachmentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', d?.id] });
      toast({ text: 'Salvato tra le risorse' });
    },
  });
  return (
    <section
      className="pm-area pm-area--neutral"
      aria-label="Allegati di posta"
      onContextMenu={menuAt(() =>
        files.length
          ? {
              title: 'Allegati di posta',
              actions: [{ id: 'all', icon: 'create_new_folder', label: 'Salva tutti tra le risorse', primary: true, run: () => files.forEach((f) => toResource.mutate(f.latest.attachmentId)) }],
            }
          : null,
      )}
    >
      <h3><Ic icon={Paperclip} size={15} /> Allegati di posta · {d ? files.length : '…'}</h3>
      {d && files.length === 0 && <span className="pm-muted" style={{ fontSize: 'var(--fs-md)' }}>Nessun allegato.</span>}
      {files.map((f) => (
        <div key={f.key}>
          <div
            className="pm-file"
            onContextMenu={menuAt(() => ({
              title: f.name,
              actions: [
                { id: 'dl', icon: 'download', label: 'Scarica', primary: true, run: () => download(`/api/attachments/${f.latest.attachmentId}`) },
                { id: 'res', icon: 'create_new_folder', label: 'Salva tra le risorse', primary: true, run: () => toResource.mutate(f.latest.attachmentId) },
                ...(f.versions.length > 1 ? [{ id: 'hist', icon: 'history', label: 'Storia delle versioni', primary: true, run: () => setHistory(f.key) }] : []),
              ],
            }))}
          >
            <Ic icon={FileText} className="pm-muted" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <a href={`/api/attachments/${f.latest.attachmentId}`} className="pm-file__name pm-truncate" style={{ display: 'block' }} title="Scarica l'ultima versione">{f.name}</a>
              <div className="pm-file__meta">
                {f.latest.from ? personLabel(f.latest.from) : ''} · {shortDate(f.latest.date)} · {fileSize(f.latest.size)}
                {f.versions.length > 1 && <> · v{f.latest.no}</>}
              </div>
            </div>
            {f.versions.length > 1 && (
              <button type="button" className="pm-file__action" title="Storia delle versioni" onClick={() => setHistory(history === f.key ? null : f.key)}>
                <Ic icon={History} size={15} />
              </button>
            )}
            <button type="button" className="pm-file__action" title="Salva tra le risorse" onClick={() => toResource.mutate(f.latest.attachmentId)}>
              <Ic icon={FolderPlus} size={15} />
            </button>
          </div>
          {history === f.key && (
            <ol className="pm-versions">
              {f.versions.map((v) => (
                <li key={v.attachmentId} style={{ listStyle: 'none' }}>
                  <a href={`/api/attachments/${v.attachmentId}`} title={`Scarica v${v.no}`}>
                    <strong>v{v.no}</strong> · {shortDate(v.date)} · {v.from ? personLabel(v.from) : '—'} · {fileSize(v.size)} <Ic icon={Download} size={15} />
                  </a>
                  {v.resent.map((r) => (
                    <div key={r.attachmentId} className="pm-muted">rinviato da {r.from ? personLabel(r.from) : '—'} · {shortDate(r.date)}</div>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}

function Resources({ d, conversationId, projectId, onUpload }: { d?: ConversationDetail; conversationId: string; projectId: string | null; onUpload: () => void }) {
  const qc = useQueryClient();
  const menuAt = useMenuAt();
  const ask = useConfirm();
  const remove = useMutation({
    mutationFn: api.deleteResource,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const list = d?.resources ?? [];
  const loading = !d;
  // Comuni a tutto il progetto: si gestiscono da "Modifica progetto".
  const { data: projectRes = [] } = useQuery({ queryKey: ['project-resources', projectId], queryFn: () => api.projectResources(projectId!), enabled: !!projectId });
  const common = projectRes.filter((r) => !r.conversationId);
  return (
    <section
      className="pm-area pm-area--neutral"
      aria-label="Risorse"
      onContextMenu={menuAt(() => ({ title: 'Risorse', actions: [{ id: 'up', icon: 'upload_file', label: 'Carica file', primary: true, run: onUpload }] }))}
    >
      <h3><Ic icon={FolderPlus} size={15} /> Risorse · {loading ? '…' : list.length + common.length}</h3>
      {common.map((r) => (
        <div
          key={r.id}
          className="pm-file"
          title="Risorsa comune del progetto (si gestisce da Modifica progetto)"
          onContextMenu={menuAt(() => ({ title: r.title, actions: [{ id: 'dl', icon: 'download', label: 'Scarica', primary: true, run: () => download(`/api/resources/${r.id}`) }] }))}
        >
          <Ic icon={FileText} className="pm-muted" />
          <a href={`/api/resources/${r.id}`} className="pm-file__name pm-truncate" style={{ flex: 1 }}>{r.title}</a>
          <span className="pm-file__meta">progetto</span>
        </div>
      ))}
      {list.map((r) => (
        <div
          key={r.id}
          className="pm-file"
          onContextMenu={menuAt(() => ({
            title: r.title,
            actions: [
              { id: 'dl', icon: 'download', label: 'Scarica', primary: true, run: () => download(`/api/resources/${r.id}`) },
              { id: 'del', icon: 'delete', label: 'Elimina', tone: 'danger' as const, run: async () => (await ask({ message: `Eliminare ${r.title}?`, okLabel: 'Elimina', danger: true })) && remove.mutate(r.id) },
            ],
          }))}
        >
          <Ic icon={FileText} className="pm-muted" />
          <a href={`/api/resources/${r.id}`} className="pm-file__name pm-truncate" style={{ flex: 1 }}>{r.title}</a>
          {r.size != null && <span className="pm-file__meta">{fileSize(r.size)}</span>}
          <button type="button" className="pm-file__action" title="Elimina" onClick={async () => (await ask({ message: `Eliminare ${r.title}?`, okLabel: 'Elimina', danger: true })) && remove.mutate(r.id)}>
            <Ic icon={Trash2} size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="pm-linkbtn" onClick={onUpload}>+ carica file</button>
    </section>
  );
}

const MAX_DEPTH = 5;

/** Albero dei messaggi (D7): sempre aperto; un clic apre la vista Email su quel messaggio. */
function MessageTree({ d, selectedId, onOpen, onCompose }: { d: ConversationDetail; selectedId: string | null; onOpen: (id: string) => void; onCompose: (r: ComposeRequest) => void }) {
  const children = new Map<string | null, MessageDto[]>();
  for (const m of d.messages) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m]);
  const ordered: { m: MessageDto; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const m of (children.get(parent) ?? []).sort((a, b) => a.date - b.date)) {
      ordered.push({ m, depth });
      walk(m.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <div className="pm-tree__list">
      {ordered.map(({ m, depth }) => (
        <TreeNode key={m.id} m={m} depth={Math.min(depth, MAX_DEPTH)} current={selectedId === m.id} onOpen={() => onOpen(m.id)} onCompose={onCompose} projectId={d.projectId} conversationId={d.id} />
      ))}
    </div>
  );
}

function TreeNode({ m, depth, current, onOpen, onCompose, projectId, conversationId }: { m: MessageDto; depth: number; current: boolean; onOpen: () => void; onCompose: (r: ComposeRequest) => void; projectId: string | null; conversationId: string }) {
  const name = useDisplayName();
  const toast = useToast();
  const from = m.from ?? { name: null, email: 'sconosciuto' };
  const unread = !m.seen && m.direction === 'in';
  const qc = useQueryClient();
  const remind = () =>
    void api.remindReply(conversationId, m.id).then(() => {
      for (const k of [['tasks'], ['conversations']]) qc.invalidateQueries({ queryKey: k });
      toast({ text: 'Task «Rispondere a…» creato' });
    });
  const ctx = useContextMenu(() => ({
    title: `${name(from)} · ${shortDate(m.date)}`,
    actions: [
      { id: 'open', icon: 'mail', label: 'Apri', primary: true, run: onOpen },
      { id: 'reply-all', icon: 'reply_all', label: 'Rispondi a tutti', primary: true, run: () => onCompose({ replyTo: m, replyAll: true, projectId }) },
      ...(projectId && m.direction === 'in' ? [{ id: 'remind', icon: 'alarm', label: 'Ricordami di rispondere', primary: true, run: remind }] : []),
      { id: 'reply', icon: 'reply', label: 'Rispondi al mittente', run: () => onCompose({ replyTo: m, replyAll: false, projectId }) },
      { id: 'copy', icon: 'content_copy', label: 'Copia testo', run: () => void navigator.clipboard.writeText(m.bodyText ?? '').then(() => toast({ text: 'Testo copiato' })) },
    ],
  }));
  return (
    <button type="button" className={`pm-tree__node${unread ? ' pm-tree__node--unread' : ''}`} style={{ ['--depth' as string]: depth }} aria-current={current ? 'true' : undefined} onClick={onOpen} {...ctx}>
      {depth > 0 && <span className="pm-tree__elbow" aria-hidden="true" />}
      <PersonAvatar person={from} size={26} />
      <span className="pm-tree__text">
        <span className="pm-tree__line">
          <span className={`pm-tree__name${unread ? ' pm-tree__name--unread' : ''}`}>{name(from)}</span>
          {m.outgoingStatus === 'queued' && <span className="pm-tree__time">in coda</span>}
          {m.outgoingStatus === 'failed' && <span className="pm-tree__time" style={{ color: 'var(--danger)' }}>invio fallito</span>}
          {m.attachments.some((a) => !a.isInline) && <Ic icon={Paperclip} size={15} className="pm-muted" />}
          <span className="pm-tree__time">{new Date(m.date).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
        </span>
        <span className="pm-tree__snippet">{m.bodyTextClean || m.bodyText}</span>
      </span>
    </button>
  );
}

/** Messaggio da cui entrare: il primo non letto; se sono tutti letti, l'ultimo ricevuto (o l'ultimo in assoluto). */
function entryMessage(messages: MessageDto[]): string | null {
  const byDate = [...messages].sort((a, b) => a.date - b.date);
  const unread = byDate.find((m) => m.direction === 'in' && !m.seen);
  if (unread) return unread.id;
  const received = byDate.filter((m) => m.direction === 'in');
  return (received.at(-1) ?? byDate.at(-1))?.id ?? null;
}
