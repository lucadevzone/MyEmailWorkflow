import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Bookmark, ChevronUp, Ellipsis, FolderInput, FolderPlus, Mail, MessagesSquare, Paperclip, Reply, Sparkles, StickyNote, X } from 'lucide-react';
import type { ConversationDetail, ConversationListItem, MessageDto, SuggestionDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { GroupBadge, PersonAvatar, PersonChip, useDisplayName, useMe } from '../ui/People.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useContextMenu, useMenuAt, useOpenMenu } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { useNavigate } from 'react-router-dom';
import { paths } from '../shell/paths.ts';
import type { ComposeRequest } from '../workspace/pane.ts';
import { TagEditor, type TagEditorTarget } from './TagEditor.tsx';
import { ResourcesSection, TaskNotesSection } from './ConversationAreas.tsx';
import { useBlockSend } from '../activities/blockSend.ts';
import { useDetach } from './useDetach.ts';
import { useConversationActions } from './useConversationActions.ts';

/**
 * Segnalibro della conversazione: grigio se nessun messaggio è importante, ocra se almeno uno lo è.
 * Un clic segna l'ultimo messaggio ricevuto come importante, o toglie il segno da tutti.
 */
function ImportantToggle({ c, large }: { c: ConversationListItem; large?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [on, setOn] = useState(c.important);
  useEffect(() => setOn(c.important), [c.important]);
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !on;
    setOn(next); // subito, senza aspettare il server
    try {
      await api.setConversationImportant(c.id, next);
      for (const k of [['conversations'], ['conversation', c.id], ['conversation-item', c.id], ['important-counts']]) void qc.invalidateQueries({ queryKey: k });
    } catch (err) {
      setOn(!next);
      toast({ text: (err as Error).message });
    }
  };
  return (
    <button
      type="button"
      className={`pm-important pm-crow__markbtn${large ? ' pm-crow__markbtn--large' : ''}`}
      aria-pressed={on}
      aria-label="Importante"
      title={on ? 'Togli importante' : 'Segna come importante'}
      onClick={(e) => void toggle(e)}
    >
      <Ic icon={Bookmark} size={large ? 18 : 15} className={`pm-crow__mark${on ? ' pm-crow__mark--on' : ''}`} />
    </button>
  );
}

/** Conversazioni (con il loro ultimo messaggio) già mandate in analisi all'apertura, in questa sessione. */
const focusAnalyzed = new Set<string>();

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
  const navigate = useNavigate();
  const anchorOf = (el: Element | null) => el?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2, 200, 0, 0);
  // Task nei progetti e in Da smistare; non nelle News e nello Spam.
  const taskable = !c.isNoise && !c.isSpam;

  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((f) => api.uploadResource(c.id, f))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', c.id] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const actions = useConversationActions(c, {
    compose: cb.onCompose,
    newTask: () => taskable && setEditor({ target: { kind: 'task', projectId: c.projectId, conversationId: c.id }, anchor: anchorOf(ref.current) }),
    newNote: () => setEditor({ target: { kind: 'note', conversationId: c.id }, anchor: anchorOf(ref.current) }),
    uploadResource: () => fileInput.current?.click(),
    toggleFocus: focused ? cb.onUnfocus : cb.onFocus,
    openMove: () => {
      const el = moveBtn.current ?? ref.current;
      if (el) openMenu({ title: 'Sposta in', actions: actions.moveTargets() }, el as HTMLElement, 'palette');
    },
    // Suggerimento "Nuovo progetto": la pagina del progetto nuovo, precompilata; salvando ci si sposta la conversazione.
    createProjectFrom: (sug: SuggestionDto) =>
      navigate(paths.newProject({ name: sug.payload.projectName as string, description: sug.payload.reason as string | undefined, suggestion: sug.id, conversation: c.id })),
  });
  const ctx = useContextMenu(() => actions.menuSpec(focused));
  // Aperta: la sua analisi mancante (sintesi, classificazione, task) passa in primo piano, anche con
  // l'analisi in background in pausa. Una volta per conversazione, e di nuovo se arrivano messaggi.
  useEffect(() => {
    if (!focused) return;
    const key = `${c.id}:${c.lastMessageAt}`;
    if (focusAnalyzed.has(key)) return;
    focusAnalyzed.add(key);
    void api.analyzeConversation(c.id).catch(() => focusAnalyzed.delete(key));
  }, [focused, c.id, c.lastMessageAt]);
  // Smistata da sola, aperta e poi lasciata senza annullare: la regola aveva ragione (RF-E6).
  const wasFocused = useRef(focused);
  const qcItem = useQueryClient();
  useEffect(() => {
    if (wasFocused.current && !focused && c.autoSorted) {
      void api.keepAutoSort(c.id).then(() => {
        for (const k of [['conversations'], ['auto-sort-stats']]) qcItem.invalidateQueries({ queryKey: k });
      });
    }
    wasFocused.current = focused;
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = c.suggestions.filter((s) => actions.suggestionLabel(s) && (s.kind !== 'task' || taskable));
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
    </>
  );

  if (!focused) {
    return (
      <article ref={ref} className={`pm-crow${c.unreadCount ? ' pm-crow--unread' : ''}`} data-conversation={c.id} {...ctx}>
        <button type="button" className="pm-crow__main" onClick={cb.onFocus} aria-label={`${title}${c.unreadCount ? `, ${c.unreadCount} da leggere` : ''}`}>
          <span className="pm-crow__dot" aria-hidden="true" />
          <Ic icon={c.messageCount > 1 ? MessagesSquare : Mail} size={16} className="pm-crow__type" label={c.messageCount > 1 ? `Conversazione di ${c.messageCount} messaggi` : 'Un messaggio'} />
          <RowPeople c={c} />
          <span className="pm-crow__title">
            <span className="pm-truncate">{title}</span>
            {c.hasDraft && <span className="pm-msg__draftmark">bozza</span>}
          </span>
        </button>
        {c.autoSorted && <AutoSortedBadge c={c} />}
        <span className="pm-crow__ind">
          {c.hasAttachments && <Ic icon={Paperclip} size={15} className="pm-crow__clip" label="Con allegati" />}
          {suggestions.length > 0 && (
            <button
              type="button"
              className="pm-suggmark"
              aria-label={`${suggestions.length === 1 ? '1 suggerimento' : `${suggestions.length} suggerimenti`} dell'assistente da accettare`}
              title={suggestions.map((x) => actions.suggestionLabel(x)).join('\n')}
              onClick={(e) =>
                openMenu(
                  {
                    title: "Suggerimenti dell'assistente",
                    actions: suggestions.map((x) => ({ id: x.id, tone: 'ai' as const, icon: 'auto_awesome', primary: true, label: actions.suggestionLabel(x)!, run: () => actions.runSuggestion(x) })),
                  },
                  e.currentTarget,
                )
              }
            >
              <Ic icon={Sparkles} size={13} />
            </button>
          )}
          <ImportantToggle c={c} />
        </span>
        <span className="pm-crow__time">{shortDate(c.lastMessageAt)}</span>
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
        {taskable && (
          <button type="button" className="pm-btn pm-btn--ghost" onClick={(e) => setEditor({ target: { kind: 'task', projectId: c.projectId, conversationId: c.id }, anchor: anchorOf(e.currentTarget) })}>
            <Icon name="assignment" size={16} /> Task
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
        <span className="pm-conv__more">
          <ImportantToggle c={c} large />
        </span>
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Comprimi la conversazione (Esc)" title="Comprimi (Esc)" onClick={cb.onUnfocus}>
          <Ic icon={ChevronUp} />
        </button>
        <button
          type="button"
          className="pm-iconbtn pm-iconbtn--sm"
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

/**
 * Chi ha scritto, nella riga compatta: un avatar (o due sovrapposti) e i nomi. Se i partecipanti sono
 * i membri di un gruppo, lo squircle del gruppo e il suo nome.
 */
function RowPeople({ c }: { c: ConversationListItem }) {
  const name = useDisplayName();
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory, staleTime: 60_000 });
  const people = c.participants;
  const emails = people.map((p) => p.email.toLowerCase());
  const group =
    people.length >= 2
      ? dir?.groups.find((g) => {
          const members = new Set(g.members.flatMap((m) => m.emails.map((e) => e.toLowerCase())));
          return members.size >= 2 && emails.every((e) => members.has(e));
        })
      : undefined;
  if (group) {
    const members = group.members.map((m) => ({ name: m.name, email: m.emails[0] ?? m.key }));
    return (
      <>
        <span className="pm-crow__avatar" aria-label={`Gruppo ${group.name}: ${members.map((m) => m.name ?? m.email).join(', ')}`}>
          <GroupBadge size={30} members={members} />
        </span>
        <span className="pm-crow__names pm-truncate">{group.name}</span>
      </>
    );
  }
  return (
    <>
      <span className="pm-crow__avatar">
        <span className="pm-stack">
          {(people.length ? people : [{ name: null, email: '?' }]).slice(0, 2).map((p) => (
            <PersonAvatar key={p.email} person={p} size={people.length > 1 ? 22 : 26} />
          ))}
        </span>
      </span>
      <span className="pm-crow__names pm-truncate" title={people.map(name).join(', ')}>
        {people.length ? people.map(name).join(', ') : '—'}
      </span>
    </>
  );
}

/**
 * Conversazione smistata da sola (RF-E6): "smistata automaticamente · Annulla". Annulla la riporta in
 * Da smistare (e la regola impara); aperta e lasciata lì, il segno sparisce e conta come giusta.
 */
function AutoSortedBadge({ c }: { c: ConversationListItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['auto-sort-stats']]) qc.invalidateQueries({ queryKey: k });
  };
  return (
    <span className="pm-autobadge" title="Spostata qui dallo smistamento automatico">
      smistata automaticamente
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void api.undoAutoSort(c.id).then(() => {
            refresh();
            toast({ text: 'Riportata in Da smistare: non la sposterò più così per questo mittente' });
          });
        }}
      >
        Annulla
      </button>
    </span>
  );
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
  const { data: tasks = [], isLoading: tasksLoading } = useQuery({ queryKey: ['tasks', 'conversation', c.id], queryFn: () => api.conversationTasks(c.id), enabled: !c.isNoise && !c.isSpam });
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
  const canRemind = !c.isNoise && !c.isSpam && !hasReplyTask && awaitingReply;
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

  const unread = d?.messages.filter((m) => m.direction === 'in' && !m.seen).length ?? 0;
  return (
    <>
      <div className="pm-focus__titlerow">
        <Ic icon={c.messageCount > 1 ? MessagesSquare : Mail} size={18} className="pm-focus__icon" />
        <h2 className="pm-focus__title">
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
          {c.autoSorted && <AutoSortedBadge c={c} />}
        </h2>
      </div>
      <div className="pm-focus__meta">
        {people.map((p) => (
          <PersonChip key={p.email} person={p} onClick={() => cb.onCompose({ to: [p.email], projectId: c.projectId })} onContextMenu={personMenu(p)} />
        ))}
        <span className="pm-muted">
          {c.messageCount} {c.messageCount === 1 ? 'messaggio' : 'messaggi'} · {shortDate(c.lastMessageAt)}
        </span>
        {c.hasDraft && <span className="pm-msg__draftmark">bozza</span>}
      </div>
      <div className="pm-conv__body">
        <div className="pm-conv__main">
          {(uniqueSuggestions.length > 0 || canRemind) && (
            <section className="pm-section" aria-label="Suggerimenti dell'assistente">
              <span className="pm-label pm-label--sugg">
                <Ic icon={Sparkles} size={13} /> Suggerimenti dell'assistente
              </span>
              <div className="pm-tags">
                {canRemind && (
                  <span className="pm-tag pm-tag--ai" title="Crea il task «Rispondere a…»: si chiude da solo quando rispondi">
                    <button type="button" onClick={remindReply} className="pm-tag__text">+ task: Ricordami di rispondere</button>
                  </span>
                )}
                {uniqueSuggestions.map((s) => (
                  <SuggestionTag key={s.id} label={actions.suggestionLabel(s)!} reason={(s.payload as { reason?: string }).reason} onRun={() => actions.runSuggestion(s)} onReject={() => actions.rejectSug.mutate(s)} />
                ))}
              </div>
            </section>
          )}
          <TaskNotesSection c={c} d={d} tasks={tasks} loading={tasksLoading} canRemind={canRemind} onRemind={remindReply} onEditor={onEditor} onOpenMessage={cb.onOpenMessage} onChanged={refreshItems} />
          <ResourcesSection c={c} d={d} onOpenMessage={cb.onOpenMessage} onUpload={onUpload} />
        </div>

        <section className="pm-conv__tree" aria-label="Sintesi e struttura della conversazione">
          <SummaryBox c={c} />
          <div className="pm-label pm-tree__label">
            Struttura · {d?.messages.length ?? c.messageCount}
            {unread > 0 && <span className="pm-tree__unreadcount">{unread === 1 ? '1 da leggere' : `${unread} da leggere`}</span>}
          </div>
          {!d && <div className="pm-empty">Caricamento…</div>}
          {d && <MessageTree d={d} selectedId={selectedMessageId} onOpen={cb.onOpenMessage} onCompose={cb.onCompose} />}
        </section>
      </div>
    </>
  );
}


/**
 * Sintesi della conversazione. Se manca: per la posta recente arriva dall'analisi in background; per quella
 * più vecchia della finestra dell'analisi (Impostazioni) si genera su richiesta, con il pulsante.
 */
function SummaryBox({ c }: { c: ConversationListItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const text = c.summaryDetailed ?? c.summary;
  const days = settings?.aiWindowDays ?? 90;
  const recent = days === 0 || c.lastMessageAt >= Date.now() - days * 86_400_000;
  const generate = async () => {
    setBusy(true);
    try {
      await api.summarizeNow(c.id);
      for (const k of [['conversations'], ['conversation-item', c.id], ['conversation', c.id]]) await qc.invalidateQueries({ queryKey: k });
    } catch (e) {
      toast({ text: `Sintesi non riuscita: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  const windowLabel = days >= 730 ? '2 anni' : days >= 365 ? '1 anno' : days >= 182 ? '6 mesi' : `${days} giorni`;
  return (
    <section className="pm-summary" aria-label="Sintesi" aria-busy={busy}>
      <div className="pm-label pm-summary__label">Sintesi</div>
      {text ? (
        <p>{text}</p>
      ) : (
        <>
          <p className="pm-muted">
            {busy
              ? "Sto leggendo la conversazione…"
              : c.isNoise || c.isSpam
                ? 'Le News e lo Spam non hanno una sintesi automatica.'
                : recent
                  ? 'Sto preparando la sintesi…'
                  : `Conversazione più vecchia di ${windowLabel}: la sintesi si genera su richiesta.`}
          </p>
          {!busy && (!recent || c.isNoise || c.isSpam) && (
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm pm-summary__gen" onClick={() => void generate()}>
              <Ic icon={Sparkles} size={14} /> Genera sintesi
            </button>
          )}
        </>
      )}
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
  // Quante risposte stanno sotto ogni messaggio (per "Stacca con le risposte").
  const below = (id: string): number => (children.get(id) ?? []).reduce((n, c) => n + 1 + below(c.id), 0);
  return (
    <div className="pm-tree__list">
      {ordered.map(({ m, depth }) => (
        <TreeNode key={m.id} m={m} depth={Math.min(depth, MAX_DEPTH)} current={selectedId === m.id} onOpen={() => onOpen(m.id)} onCompose={onCompose} projectId={d.projectId} conversationId={d.id} replies={below(m.id)} />
      ))}
    </div>
  );
}

function TreeNode({ m, depth, current, onOpen, onCompose, projectId, conversationId, replies }: { m: MessageDto; depth: number; current: boolean; onOpen: () => void; onCompose: (r: ComposeRequest) => void; projectId: string | null; conversationId: string; replies: number }) {
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
      ...(m.parentId && !queued ? detacher.menuActions(m.id, projectId, replies) : []),
      { id: 'copy', icon: 'content_copy', label: 'Copia testo', run: () => void navigator.clipboard.writeText(m.bodyText ?? '').then(() => toast({ text: 'Testo copiato' })) },
    ],
  }));
  return (
    <button
      type="button"
      className={`pm-tree__node${unread ? ' pm-tree__node--unread' : ''}`}
      style={{ ['--depth' as string]: depth }}
      aria-current={current ? 'true' : undefined}
      aria-label={`${name(from)}, ${shortDate(m.date)}${unread ? ', non letto' : ''}`}
      onClick={onOpen}
      {...ctx}
    >
      {depth > 0 && <span className="pm-tree__elbow" aria-hidden="true" />}
      <PersonAvatar person={from} size={26} />
      <span className="pm-tree__text">
        <span className="pm-tree__line">
          <span className={`pm-tree__name${unread ? ' pm-tree__name--unread' : ''}`}>{name(from)}</span>
          {m.outgoingStatus === 'queued' && <span className="pm-tree__time">in coda</span>}
          {m.outgoingStatus === 'failed' && <span className="pm-tree__time" style={{ color: 'var(--danger)' }}>invio fallito</span>}
          {m.attachments.some((a) => !a.isInline) && <Ic icon={Paperclip} size={15} className="pm-muted" />}
          <span className="pm-tree__time">{new Date(m.date).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
          {unread && <span className="pm-tree__dot" aria-hidden="true" />}
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
