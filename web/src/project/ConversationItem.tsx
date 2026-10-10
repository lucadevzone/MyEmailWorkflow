import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Bookmark, Ellipsis, FolderInput, FolderPlus, Paperclip, Reply, SquareCheck, StickyNote, X } from 'lucide-react';
import type { ConversationDetail, ConversationListItem, MessageDto, SuggestionDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { PeopleLine, PersonAvatar, PersonChip, useDisplayName, useMe } from '../ui/People.tsx';
import { useContextMenu, useMenuAt, useOpenMenu } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { ProjectDialog } from '../projects/ProjectDialog.tsx';
import type { ComposeRequest } from '../workspace/pane.ts';
import { TagEditor, type TagEditorTarget } from './TagEditor.tsx';
import { ResourcesArea, TaskArea } from './ConversationAreas.tsx';
import { useBlockSend } from '../activities/blockSend.ts';
import { useDetach } from './useDetach.ts';
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
  const refreshItems = () => {
    for (const k of [['tasks'], ['conversation', c.id], ['conversations']]) qc.invalidateQueries({ queryKey: k });
  };
  const hasReplyTask = openTasks.some((t) => t.title.startsWith('Rispondere a '));
  const remindReply = () => void api.remindReply(c.id).then(refreshItems);
  // Solo se l'ultimo messaggio è arrivato (non ho ancora risposto).
  const awaitingReply = d?.messages.at(-1)?.direction === 'in'; // i messaggi arrivano in ordine di data
  const canRemind = !!c.projectId && !hasReplyTask && awaitingReply;
  // Lo stesso suggerimento due volte (vecchie estrazioni ripetute) si mostra una volta sola.
  const uniqueSuggestions = suggestions.filter((s, i, all) => all.findIndex((x) => actions.suggestionLabel(x) === actions.suggestionLabel(s)) === i);
  const toast = useToast();
  // Io non compaio tra i partecipanti: ci sono sempre.
  const people = c.participants.filter((p) => p.email.toLowerCase() !== me?.email.toLowerCase());
  const { data: members } = useQuery({ queryKey: ['project-members', c.projectId], queryFn: () => api.projectMembers(c.projectId!), enabled: !!c.projectId });
  const memberEmails = new Set((members?.contacts ?? []).flatMap((p) => p.emails.map((e) => e.toLowerCase())));
  const personMenu = (p: { name: string | null; email: string }) =>
    menuAt(() => ({
      title: p.name || p.email,
      actions: [
        { id: 'write', icon: 'edit', label: `Scrivi solo a ${p.name || p.email}`, primary: true, run: () => cb.onCompose({ to: [p.email], projectId: c.projectId }) },
        ...(c.projectId && !memberEmails.has(p.email.toLowerCase())
          ? [{
              id: 'add', icon: 'person_add', label: 'Aggiungi ai contatti del progetto', primary: true,
              run: () => void api.addProjectContact(c.projectId!, { name: p.name ?? undefined, email: p.email }).then(() => {
                qc.invalidateQueries({ queryKey: ['project-members', c.projectId] });
                toast({ text: `${p.name || p.email} aggiunto ai contatti del progetto` });
              }),
            }]
          : []),
      ],
    }));

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
            <PersonChip key={p.email} person={p} onClick={() => cb.onCompose({ to: [p.email], projectId: c.projectId })} onContextMenu={personMenu(p)} />
          ))}
          <span className="pm-muted" style={{ fontSize: 'var(--fs-md)' }}>· {c.messageCount} {c.messageCount === 1 ? 'messaggio' : 'messaggi'}</span>
        </div>
        {(uniqueSuggestions.length > 0 || canRemind) && (
          <div className="pm-conv__suggestions">
            {canRemind && (
              <span className="pm-tag pm-tag--ai" title="Crea il task «Rispondere a…»: si chiude da solo quando rispondi">
                <button type="button" onClick={remindReply} className="pm-tag__text">+ Task: Ricordami di rispondere</button>
              </span>
            )}
            {uniqueSuggestions.map((s) => (
              <SuggestionTag key={s.id} label={actions.suggestionLabel(s)!} reason={(s.payload as { reason?: string }).reason} onRun={() => actions.runSuggestion(s)} onReject={() => actions.rejectSug.mutate(s)} />
            ))}
          </div>
        )}

        <div className="pm-areas pm-areas--stack">
          {c.projectId && (
            <TaskArea c={c} tasks={tasks} loading={tasksLoading} canRemind={canRemind} onRemind={remindReply} onEditor={onEditor} onOpenMessage={cb.onOpenMessage} onChanged={refreshItems} />
          )}
          <ResourcesArea c={c} d={d} onEditor={onEditor} onOpenMessage={cb.onOpenMessage} onUpload={onUpload} onChanged={refreshItems} />
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
  const block = useBlockSend();
  const detacher = useDetach();
  const queued = m.outgoingStatus === 'queued' || m.outgoingStatus === 'failed';
  const remind = () =>
    void api.remindReply(conversationId, m.id).then(() => {
      for (const k of [['tasks'], ['conversations']]) qc.invalidateQueries({ queryKey: k });
      toast({ text: 'Task «Rispondere a…» creato' });
    });
  const ctx = useContextMenu(() => ({
    title: `${name(from)} · ${shortDate(m.date)}`,
    actions: [
      { id: 'open', icon: 'mail', label: 'Apri', primary: true, run: onOpen },
      ...(queued ? [{ id: 'block', icon: 'cancel_schedule_send', label: 'Blocca invio', primary: true, run: () => void block.byMessage(m.id) }] : []),
      { id: 'reply-all', icon: 'reply_all', label: 'Rispondi a tutti', primary: true, run: () => onCompose({ replyTo: m, replyAll: true, projectId }) },
      ...(projectId && m.direction === 'in' ? [{ id: 'remind', icon: 'alarm', label: 'Ricordami di rispondere', primary: true, run: remind }] : []),
      { id: 'reply', icon: 'reply', label: 'Rispondi al mittente', run: () => onCompose({ replyTo: m, replyAll: false, projectId }) },
      // Il primo messaggio è già l'inizio della conversazione: non si stacca.
      ...(m.parentId && !queued ? detacher.menuActions(m.id, projectId) : []),
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
