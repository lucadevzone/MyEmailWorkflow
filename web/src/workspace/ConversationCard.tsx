import { useEffect, useRef, useState } from 'react';
import { useConfirm } from '../ui/confirm.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationDetail, ConversationListItem, MessageDto, PersonRef, SuggestionDto } from '@mmw/shared';
import { ProjectDialog } from '../projects/ProjectDialog.tsx';
import { TaskRow } from '../tasks/TasksPanel.tsx';
import { dueInfo, useTaskOps } from '../tasks/useTaskOps.ts';
import { api } from '../api.ts';
import { fileSize, personLabel, shortDate } from '../lib/format.ts';
import { Badge } from '../ui/Badge.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useToast } from '../ui/toast.tsx';
import type { PaneAction } from './pane.ts';
import { useContextMenu, useOpenMenu, type MenuAction } from '../ui/contextMenu.tsx';

type Section = 'summary' | 'attachments' | 'notes' | 'resources' | 'tasks';

export function ConversationCard({
  c,
  expanded,
  selectedMessageId,
  onToggle,
  pane,
}: {
  c: ConversationListItem;
  expanded: boolean;
  selectedMessageId: string | null;
  onToggle: () => void;
  pane: PaneAction;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const [open, setOpen] = useState<Set<Section>>(new Set());
  const [menu, setMenu] = useState(false);
  const [creatingFrom, setCreatingFrom] = useState<SuggestionDto | null>(null);
  const liRef = useRef<HTMLLIElement>(null);
  const openMenu = useOpenMenu();
  const fileInput = useRef<HTMLInputElement>(null);
  const autoOpened = useRef(false);
  const needDetail = expanded || open.has('attachments') || open.has('notes') || open.has('resources');
  const { data: detail } = useQuery({ queryKey: ['conversation', c.id], queryFn: () => api.conversation(c.id), enabled: needDetail });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['conversations'] });
    qc.invalidateQueries({ queryKey: ['conversation', c.id] });
    qc.invalidateQueries({ queryKey: ['counts'] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  // Espandendo la conversazione si apre il primo messaggio non letto (o l'ultimo).
  useEffect(() => {
    if (!expanded) {
      autoOpened.current = false;
      return;
    }
    if (detail && !autoOpened.current) {
      autoOpened.current = true;
      const target = detail.messages.find((m) => !m.seen && m.direction === 'in') ?? detail.messages[detail.messages.length - 1];
      if (target) pane.openMessage(c.id, target.id);
    }
  }, [expanded, detail, c.id, pane]);

  const toggle = (s: Section) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const loadDetail = () => qc.fetchQuery({ queryKey: ['conversation', c.id], queryFn: () => api.conversation(c.id) });

  const reply = async () => {
    const d = detail ?? (await loadDetail());
    const last = d.messages[d.messages.length - 1];
    if (last) pane.compose({ replyTo: last, replyAll: true, projectId: d.projectId });
  };

  const archive = useMutation({
    mutationFn: () => api.archive(c.id),
    onSuccess: (res) => {
      refresh();
      toast({
        text: 'Conversazione archiviata',
        action: { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) },
      });
    },
  });
  const unarchive = useMutation({ mutationFn: () => api.unarchive(c.id), onSuccess: refresh });
  const trash = useMutation({
    mutationFn: () => api.trash(c.id),
    onSuccess: (res) => {
      refresh();
      toast({
        text: 'Spostata nel cestino',
        action: { label: 'Annulla', run: () => void Promise.all(res.activityIds.map(api.cancelActivity)).then(refresh) },
      });
    },
  });
  const move = useMutation({
    mutationFn: (projectId: string | null) => api.move(c.id, projectId),
    onSuccess: (res, projectId) => {
      refresh();
      const name = projectId ? projects.find((p) => p.id === projectId)?.name : 'Da smistare';
      toast({ text: `Spostata in ${name}`, action: { label: 'Annulla', run: () => void api.move(c.id, res.previousProjectId).then(refresh) } });
    },
  });
  const unread = useMutation({ mutationFn: () => api.markUnread(c.id), onSuccess: refresh });
  const noise = useMutation({ mutationFn: () => api.setNoise(c.id, !c.isNoise), onSuccess: refresh });
  const upload = useMutation({
    mutationFn: (files: File[]) => Promise.all(files.map((f) => api.uploadResource(c.id, f))),
    onSuccess: () => {
      refresh();
      setOpen((p) => new Set(p).add('resources'));
    },
  });
  const removeResource = useMutation({ mutationFn: api.deleteResource, onSuccess: refresh });

  const acceptSug = useMutation({
    mutationFn: ({ sug, projectId }: { sug: SuggestionDto; projectId?: string }) => api.acceptSuggestion(sug.id, projectId),
    onSuccess: (res, { sug }) => {
      refresh();
      qc.invalidateQueries({ queryKey: ['tasks'] });
      const ids = (res as { activityIds?: string[] }).activityIds;
      if (sug.kind === 'project') toast({ text: `Spostata in ${sug.payload.projectName}`, action: { label: 'Annulla', run: () => void api.move(c.id, null).then(refresh) } });
      else if (ids?.length) toast({ text: 'Conversazione archiviata', action: { label: 'Annulla', run: () => void Promise.all(ids.map(api.cancelActivity)).then(refresh) } });
    },
  });
  const toProject = useMutation({
    mutationFn: () => api.participantsToProject(c.id, c.subject ?? undefined),
    onSuccess: () => {
      for (const k of [['project-members'], ['directory'], ['people']]) qc.invalidateQueries({ queryKey: k });
      toast({ text: 'Destinatari aggiunti al progetto' });
    },
  });

  /** Azioni del menu contestuale: prima le suggerite, poi le principali (barra), poi le altre (palette). */
  const menuSpec = () => {
    const suggested: MenuAction[] = [];
    for (const sug of c.suggestions) {
      const p = sug.payload as { projectName?: string; title?: string; action?: string; draft?: string; messageId?: string };
      const pct = sug.confidence != null ? ` · ${Math.round(sug.confidence * 100)}%` : '';
      if (sug.kind === 'project') suggested.push({ id: sug.id, tone: 'ai', icon: 'drive_file_move', label: `Sposta in ${p.projectName}${pct}`, run: () => acceptSug.mutate({ sug }) });
      else if (sug.kind === 'new_project') suggested.push({ id: sug.id, tone: 'ai', icon: 'create_new_folder', label: `Nuovo progetto «${p.projectName}»`, run: () => setCreatingFrom(sug) });
      else if (sug.kind === 'task' && c.projectId) suggested.push({ id: sug.id, tone: 'ai', icon: 'add_task', label: `Task: ${p.title}`, run: () => acceptSug.mutate({ sug }) });
      else if (sug.kind === 'action' && p.action === 'reply')
        suggested.push({
          id: sug.id, tone: 'ai', icon: 'quickreply', label: `Rispondi: «${(p.draft ?? '').slice(0, 30)}…»`, keywords: p.draft,
          run: async () => {
            const d = await loadDetail();
            const m = d.messages.find((x) => x.id === p.messageId) ?? d.messages[d.messages.length - 1];
            if (m) pane.compose({ replyTo: m, replyAll: true, projectId: d.projectId, draft: p.draft });
          },
        });
      else if (sug.kind === 'action' && p.action === 'archive') suggested.push({ id: sug.id, tone: 'ai', icon: 'archive', label: 'Archivia (suggerito)', run: () => acceptSug.mutate({ sug }) });
      else if (sug.kind === 'action' && p.action === 'noise') suggested.push({ id: sug.id, tone: 'ai', icon: 'block', label: 'È rumore (suggerito)', run: () => acceptSug.mutate({ sug }) });
    }
    const moveTargets: MenuAction[] = [
      ...(c.projectId ? [{ id: 'move-inbox', icon: 'inbox', label: 'Sposta in Da smistare', keywords: 'sposta', run: () => move.mutate(null) }] : []),
      ...projects
        .filter((p) => !p.archived && p.id !== c.projectId)
        .map((p) => ({ id: `move-${p.id}`, icon: 'folder', label: `Sposta in ${p.name}`, keywords: 'sposta progetto', run: () => move.mutate(p.id) })),
    ];
    const actions: MenuAction[] = [
      ...suggested,
      { id: 'reply', icon: 'reply_all', label: 'Rispondi', primary: true, run: reply },
      {
        id: 'move', icon: 'drive_file_move', label: 'Sposta in…', primary: true, keywords: 'progetto',
        run: () => {
          if (liRef.current) openMenu({ title: 'Sposta in', actions: moveTargets }, liRef.current, 'palette');
        },
      },
      c.archived
        ? { id: 'unarchive', icon: 'unarchive', label: 'Ripristina', primary: true, run: () => unarchive.mutate() }
        : { id: 'archive', icon: 'archive', label: 'Archivia', primary: true, run: () => archive.mutate() },
      ...moveTargets,
      ...(c.projectId ? [{ id: 'task', icon: 'add_task', label: 'Nuovo task', run: () => setOpen((p) => new Set(p).add('tasks')) }] : []),
      { id: 'note', icon: 'sticky_note_2', label: 'Nuova nota', run: () => pane.openNote(c.id, null) },
      { id: 'upload', icon: 'upload_file', label: 'Carica file', keywords: 'risorsa', run: () => fileInput.current?.click() },
      { id: 'unread', icon: 'mark_email_unread', label: 'Segna come non letta', run: () => unread.mutate() },
      ...(!c.projectId ? [{ id: 'noise', icon: 'block', label: c.isNoise ? 'Non è rumore' : 'È rumore', run: () => noise.mutate() }] : []),
      ...(c.projectId && c.participants.length
        ? [{ id: 'members', icon: 'group_add', label: c.participants.length > 1 ? 'Aggiungi i destinatari al progetto come gruppo' : `Aggiungi ${personLabel(c.participants[0]!)} al progetto`, run: () => toProject.mutate() }]
        : []),
      { id: 'toggle', icon: expanded ? 'unfold_less' : 'unfold_more', label: expanded ? 'Chiudi conversazione' : 'Apri conversazione', run: onToggle },
      {
        id: 'trash', icon: 'delete', label: 'Cestina', tone: 'danger', keywords: 'elimina',
        confirm: { message: 'Spostare la conversazione nel cestino?', okLabel: 'Cestina', danger: true },
        run: () => trash.mutate(),
      },
    ];
    return { title: c.summary ?? c.subject ?? 'Conversazione', actions };
  };
  const ctx = useContextMenu(menuSpec);

  const title = c.summary ?? c.subject ?? '(nessun oggetto)';
  const hasExtras = c.attachmentCount + c.noteCount + c.resourceCount + c.taskCount > 0 || open.has('tasks');

  return (
    <li
      ref={liRef}
      tabIndex={0}
      {...ctx}
      className={`border-b border-stone-200 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400 dark:border-stone-800 ${expanded ? 'bg-white dark:bg-stone-900' : ''}`}
    >
      {creatingFrom && (
        <ProjectDialog
          initialName={creatingFrom.payload.projectName}
          initialDescription={creatingFrom.payload.reason}
          onClose={() => setCreatingFrom(null)}
          onSaved={(p) => acceptSug.mutate({ sug: creatingFrom, projectId: p.id })}
        />
      )}
      <div className="flex gap-3 px-4 py-3">
        <div className="w-5 shrink-0 pt-0.5">
          <Badge n={c.unreadCount} tone="red" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* Riga 1: sintesi (clic = versione dettagliata) */}
          <button className="block w-full text-left" onClick={() => (expanded ? toggle('summary') : onToggle())}>
            <div className="flex items-baseline gap-2">
              <span className={`min-w-0 flex-1 text-sm ${c.unreadCount ? 'font-semibold' : 'font-medium'} ${open.has('summary') ? '' : 'truncate'}`}>
                {title}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-stone-500">{shortDate(c.lastMessageAt)}</span>
            </div>
            {open.has('summary') && (
              <p className="mt-1 line-clamp-5 text-sm text-stone-600 dark:text-stone-300">
                {c.summaryDetailed ?? (c.summary ? c.snippet : 'Sintesi in preparazione…')}
              </p>
            )}
            {c.summary && c.subject && !open.has('summary') && <div className="truncate text-xs text-stone-400">{c.subject}</div>}
          </button>

          {/* Riga 2: persone coinvolte (clic = nuovo messaggio) */}
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
            {c.participants.length === 0 && <span className="text-stone-400">solo io</span>}
            {c.participants.slice(0, 6).map((p) => (
              <PersonLink key={p.email} p={p} onClick={() => pane.compose({ to: [p.email], projectId: c.projectId })} />
            ))}
            {c.participants.length > 6 && <span className="text-stone-400">+{c.participants.length - 6}</span>}
          </div>

          {/* Riga 3: allegati, note, risorse */}
          {hasExtras && (
            <div className="flex gap-3 text-xs text-stone-500">
              {(c.taskCount > 0 || open.has('tasks')) && <ExtraButton icon="task_alt" n={c.taskCount} active={open.has('tasks')} onClick={() => toggle('tasks')} title="Task" />}
              {c.attachmentCount > 0 && <ExtraButton icon="attach_file" n={c.attachmentCount} active={open.has('attachments')} onClick={() => toggle('attachments')} title="Allegati" />}
              {c.noteCount > 0 && <ExtraButton icon="sticky_note_2" n={c.noteCount} active={open.has('notes')} onClick={() => toggle('notes')} title="Note" />}
              {c.resourceCount > 0 && <ExtraButton icon="inventory_2" n={c.resourceCount} active={open.has('resources')} onClick={() => toggle('resources')} title="Risorse" />}
            </div>
          )}
          {open.has('tasks') && <ConversationTasks c={c} />}
          {open.has('attachments') && detail && <Attachments d={detail} />}
          {open.has('notes') && detail && (
            <ul className="space-y-1 rounded-md bg-amber-50 p-2 text-xs dark:bg-amber-950/30">
              {detail.notes.map((n) => (
                <li key={n.id}>
                  <button className="block w-full truncate text-left hover:underline" onClick={() => pane.openNote(c.id, n.id)}>
                    {n.body.split('\n')[0]}
                  </button>
                </li>
              ))}
              <li>
                <button className="text-stone-500 hover:underline" onClick={() => pane.openNote(c.id, null)}>
                  + nuova nota
                </button>
              </li>
            </ul>
          )}
          {open.has('resources') && detail && (
            <ul className="space-y-1 rounded-md bg-stone-100 p-2 text-xs dark:bg-stone-800/60">
              {detail.resources.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <a className="min-w-0 flex-1 truncate hover:underline" href={`/api/resources/${r.id}`}>
                    {r.title}
                  </a>
                  {r.size != null && <span className="text-stone-500">{fileSize(r.size)}</span>}
                  <button className="text-stone-400 hover:text-rose-600" title="Elimina" onClick={async () => (await ask({ message: `Eliminare ${r.title}?`, okLabel: 'Elimina', danger: true })) && removeResource.mutate(r.id)}>
                    <Icon name="delete" size={16} />
                  </button>
                </li>
              ))}
              <li>
                <button className="text-stone-500 hover:underline" onClick={() => fileInput.current?.click()}>
                  + carica file
                </button>
              </li>
            </ul>
          )}

          {/* Riga 4: azioni */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <SmallButton tone="primary" onClick={() => void reply()}>
              Rispondi
            </SmallButton>
            {/* Azioni suggerite (tono "ai"); da M4 anche quelle dell'analizzatore. */}
            {c.suggestions.map((sug) => (
              <SuggestionButton key={sug.id} c={c} sug={sug} pane={pane} />
            ))}
            {expanded && c.projectId && <ParticipantsSuggestion c={c} />}
            {c.archived ? (
              <SmallButton tone="neutral" onClick={() => unarchive.mutate()}>
                Ripristina
              </SmallButton>
            ) : (
              <SmallButton tone="danger" onClick={() => archive.mutate()}>
                Archivia
              </SmallButton>
            )}
            <div className="relative ml-auto">
              <button className="flex size-6 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800" onClick={() => setMenu(!menu)} title="Altre azioni">
                <Icon name="more_horiz" size={18} />
              </button>
              {menu && (
                <div className="absolute right-0 top-7 z-20 w-56 rounded-lg border border-stone-200 bg-white p-1 text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900" onMouseLeave={() => setMenu(false)}>
                  <label className="block px-2 py-1 text-xs text-stone-500">
                    Sposta in
                    <select
                      className="mt-1 block w-full rounded border border-stone-300 bg-transparent px-1 py-1 text-sm text-stone-900 dark:border-stone-700 dark:text-stone-100"
                      value={c.projectId ?? ''}
                      onChange={(e) => {
                        setMenu(false);
                        move.mutate(e.target.value || null);
                      }}
                    >
                      <option value="">Da smistare</option>
                      {projects.filter((p) => !p.archived || p.id === c.projectId).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <MenuItem icon="sticky_note_2" onClick={() => { setMenu(false); pane.openNote(c.id, null); }}>Nuova nota</MenuItem>
                  <MenuItem icon="add_task" onClick={() => { setMenu(false); setOpen((p) => new Set(p).add('tasks')); }}>Nuovo task</MenuItem>
                  <MenuItem icon="upload_file" onClick={() => { setMenu(false); fileInput.current?.click(); }}>Carica file</MenuItem>
                  <MenuItem icon="mark_email_unread" onClick={() => { setMenu(false); unread.mutate(); }}>Segna come non letta</MenuItem>
                  {!c.projectId && (
                    <MenuItem icon="block" onClick={() => { setMenu(false); noise.mutate(); }}>{c.isNoise ? 'Non è rumore' : 'È rumore'}</MenuItem>
                  )}
                  <MenuItem icon="delete" onClick={() => { setMenu(false); trash.mutate(); }}>Cestina</MenuItem>
                </div>
              )}
            </div>
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
          </div>
          {upload.error && <div className="text-xs text-rose-600">{(upload.error as Error).message}</div>}
        </div>
      </div>

      {/* Albero dei messaggi */}
      {expanded && detail && (
        <MessageTree messages={detail.messages} selectedId={selectedMessageId} onOpen={(id) => pane.openMessage(c.id, id)} conversation={detail} pane={pane} />
      )}
    </li>
  );
}

/** Task collegati alla conversazione, con aggiunta rapida (solo se la conversazione è in un progetto). */
function ConversationTasks({ c }: { c: ConversationListItem }) {
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks', 'conversation', c.id], queryFn: () => api.conversationTasks(c.id) });
  const ops = useTaskOps();
  const [title, setTitle] = useState('');
  return (
    <div className="rounded-md bg-emerald-50/60 p-1.5 dark:bg-emerald-950/20">
      {tasks.map((t) => (
        <TaskRow key={t.id} t={t} compact />
      ))}
      {c.projectId ? (
        <form
          className="px-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) ops.create.mutate({ projectId: c.projectId!, title, conversationId: c.id }, { onSuccess: () => setTitle('') });
          }}
        >
          <input className="w-full bg-transparent text-xs outline-none placeholder:text-stone-400" placeholder="+ nuovo task (Invio)" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!tasks.length} />
        </form>
      ) : (
        <p className="px-2 text-xs text-stone-500">I task stanno nei progetti: sposta prima la conversazione in un progetto.</p>
      )}
    </div>
  );
}

/** Suggerimento dell'analizzatore (calcolato in background): clic = applica, × = scarta. */
function SuggestionButton({ c, sug, pane }: { c: ConversationListItem; sug: SuggestionDto; pane: PaneAction }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['conversation', c.id]]) qc.invalidateQueries({ queryKey: k });
  };
  const accept = useMutation({
    mutationFn: (projectId?: string) => api.acceptSuggestion(sug.id, projectId),
    onSuccess: () => {
      refresh();
      toast({
        text: `Spostata in ${sug.payload.projectName}`,
        action: { label: 'Annulla', run: () => void api.move(c.id, null).then(refresh) },
      });
    },
  });
  const reject = useMutation({ mutationFn: () => api.rejectSuggestion(sug.id), onSuccess: refresh });
  if (sug.kind === 'task') return <TaskSuggestion c={c} sug={sug} onReject={() => reject.mutate()} />;
  if (sug.kind === 'action') return <ActionSuggestion c={c} sug={sug} pane={pane} onReject={() => reject.mutate()} />;
  if (sug.kind !== 'project' && sug.kind !== 'new_project') return null;

  const pct = sug.confidence != null ? ` · ${Math.round(sug.confidence * 100)}%` : '';
  const label = sug.kind === 'project' ? `Sposta in ${sug.payload.projectName}${pct}` : `Nuovo progetto «${sug.payload.projectName}»`;
  return (
    <span className="inline-flex items-stretch overflow-hidden rounded bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
      <button
        className="whitespace-nowrap px-2 py-0.5 text-xs font-medium hover:bg-violet-200 dark:hover:bg-violet-800/60"
        title={sug.payload.reason || 'Suggerito dall\'analizzatore'}
        disabled={accept.isPending}
        onClick={() => (sug.kind === 'project' ? accept.mutate(undefined) : setCreating(true))}
      >
        {label}
      </button>
      <button className="px-1 hover:bg-violet-200 dark:hover:bg-violet-800/60" title="Scarta il suggerimento" onClick={() => reject.mutate()}>
        <Icon name="close" size={14} />
      </button>
      {creating && (
        <ProjectDialog
          initialName={sug.payload.projectName}
          initialDescription={sug.payload.reason}
          onClose={() => setCreating(false)}
          onSaved={(p) => accept.mutate(p.id)}
        />
      )}
    </span>
  );
}

/** Azione rapida suggerita: rispondi (apre il compositore con la bozza), archivia, è rumore. */
function ActionSuggestion({ c, sug, pane, onReject }: { c: ConversationListItem; sug: SuggestionDto; pane: PaneAction; onReject: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const p = sug.payload as { action: 'reply' | 'archive' | 'noise'; messageId: string; draft?: string; reason?: string };
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['conversation', c.id]]) qc.invalidateQueries({ queryKey: k });
  };
  const accept = useMutation({
    mutationFn: () => api.acceptSuggestion(sug.id),
    onSuccess: (res) => {
      refresh();
      if (p.action === 'archive') {
        const ids = (res as { activityIds?: string[] }).activityIds ?? [];
        toast({ text: 'Conversazione archiviata', action: { label: 'Annulla', run: () => void Promise.all(ids.map(api.cancelActivity)).then(refresh) } });
      } else {
        toast({ text: 'Spostata nel Rumore', action: { label: 'Annulla', run: () => void api.setNoise(c.id, false).then(refresh) } });
      }
    },
  });
  const reply = async () => {
    const d = await qc.fetchQuery({ queryKey: ['conversation', c.id], queryFn: () => api.conversation(c.id) });
    const m = d.messages.find((x) => x.id === p.messageId) ?? d.messages[d.messages.length - 1];
    if (m) pane.compose({ replyTo: m, replyAll: true, projectId: d.projectId, draft: p.draft });
  };
  const preview = (p.draft ?? '').replace(/\s+/g, ' ');
  const label =
    p.action === 'reply' ? `Rispondi: «${preview.length > 40 ? `${preview.slice(0, 40)}…` : preview}»` : p.action === 'archive' ? 'Archivia' : 'È rumore';

  return (
    <span className="inline-flex items-stretch overflow-hidden rounded bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
      <button
        className="max-w-80 truncate whitespace-nowrap px-2 py-0.5 text-xs font-medium hover:bg-violet-200 dark:hover:bg-violet-800/60"
        title={[p.reason, p.draft].filter(Boolean).join('\n\n') || 'Suggerito dall\'analizzatore'}
        disabled={accept.isPending}
        onClick={() => (p.action === 'reply' ? void reply() : accept.mutate())}
      >
        {label}
      </button>
      <button className="px-1 hover:bg-violet-200 dark:hover:bg-violet-800/60" title="Scarta il suggerimento" onClick={onReject}>
        <Icon name="close" size={14} />
      </button>
    </span>
  );
}

/** Task suggerito: clic = crea il task (da Da smistare si sceglie prima il progetto). */
function TaskSuggestion({ c, sug, onReject }: { c: ConversationListItem; sug: SuggestionDto; onReject: () => void }) {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const proposed = c.suggestions.find((x) => x.kind === 'project')?.payload.projectId ?? '';
  const [choosing, setChoosing] = useState(false);
  const [projectId, setProjectId] = useState(proposed);
  const accept = useMutation({
    mutationFn: (pid?: string) => api.acceptSuggestion(sug.id, pid),
    onSuccess: () => {
      for (const k of [['conversations'], ['tasks'], ['projects'], ['counts']]) qc.invalidateQueries({ queryKey: k });
      setChoosing(false);
    },
  });
  const p = sug.payload as { title?: string; dueDate?: string | null; details?: string | null };
  const due = dueInfo(p.dueDate ?? null);

  return (
    <span className="inline-flex items-stretch overflow-hidden rounded bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
      <button
        className="max-w-72 truncate whitespace-nowrap px-2 py-0.5 text-xs font-medium hover:bg-violet-200 dark:hover:bg-violet-800/60"
        title={p.details ?? p.title}
        disabled={accept.isPending}
        onClick={() => (c.projectId ? accept.mutate(undefined) : setChoosing(!choosing))}
      >
        + Task: {p.title}
        {due && ` · ${due.label}`}
      </button>
      {choosing && (
        <span className="flex items-center gap-1 px-1">
          <select className="rounded bg-white px-1 text-xs text-stone-900 dark:bg-stone-800 dark:text-stone-100" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="" disabled>
              progetto…
            </option>
            {projects.filter((x) => !x.archived).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button className="rounded bg-violet-600 px-1.5 text-xs text-white disabled:opacity-50" disabled={!projectId} onClick={() => accept.mutate(projectId)}>
            Crea
          </button>
        </span>
      )}
      <button className="px-1 hover:bg-violet-200 dark:hover:bg-violet-800/60" title="Scarta il suggerimento" onClick={onReject}>
        <Icon name="close" size={14} />
      </button>
    </span>
  );
}

/**
 * Suggerimento: i destinatari della conversazione non sono ancora nel progetto →
 * aggiungerli come contatto (se è uno) o come gruppo (se sono più di uno).
 */
function ParticipantsSuggestion({ c }: { c: ConversationListItem }) {
  const qc = useQueryClient();
  const { data: members } = useQuery({ queryKey: ['project-members', c.projectId], queryFn: () => api.projectMembers(c.projectId!) });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(c.subject ?? '');
  const add = useMutation({
    mutationFn: () => api.participantsToProject(c.id, name),
    onSuccess: () => {
      setNaming(false);
      for (const k of [['project-members', c.projectId], ['directory'], ['people']]) qc.invalidateQueries({ queryKey: k });
    },
  });
  if (!members || !c.participants.length) return null;
  const covered = new Set([...members.contacts, ...members.groups.flatMap((g) => g.members)].flatMap((p) => p.emails));
  if (c.participants.every((p) => covered.has(p.email))) return null;

  const single = c.participants.length === 1;
  if (naming) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <input className="w-40 rounded border border-violet-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-violet-700" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome del gruppo" autoFocus />
        <SmallButton tone="ai" onClick={() => add.mutate()}>
          Crea gruppo
        </SmallButton>
        <button type="button" className="text-xs text-stone-400" onClick={() => setNaming(false)}>
          annulla
        </button>
      </form>
    );
  }
  return (
    <SmallButton tone="ai" onClick={() => (single ? add.mutate() : setNaming(true))}>
      {single ? `Aggiungi ${personLabel(c.participants[0]!)} al progetto` : `Aggiungi i ${c.participants.length} destinatari come gruppo`}
    </SmallButton>
  );
}

function PersonLink({ p, onClick }: { p: PersonRef; onClick: () => void }) {
  return (
    <button className="text-stone-600 hover:text-sky-700 hover:underline dark:text-stone-300" title={`Scrivi a ${p.email}`} onClick={onClick}>
      {personLabel(p)}
    </button>
  );
}

function ExtraButton({ icon, n, active, onClick, title }: { icon: string; n: number; active: boolean; onClick: () => void; title: string }) {
  return (
    <button className={`flex items-center gap-0.5 rounded px-1 ${active ? 'bg-stone-200 text-stone-900 dark:bg-stone-700 dark:text-stone-100' : 'hover:text-stone-900 dark:hover:text-stone-100'}`} onClick={onClick} title={title}>
      <Icon name={icon} size={16} />
      {n}
    </button>
  );
}

function SmallButton({ tone, onClick, children }: { tone: 'primary' | 'ai' | 'danger' | 'neutral'; onClick: () => void; children: React.ReactNode }) {
  const cls = {
    primary: 'bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900',
    ai: 'bg-violet-100 text-violet-800 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-200',
    danger: 'bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300',
    neutral: 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200',
  }[tone];
  return (
    <button className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${cls}`} onClick={onClick}>
      {children}
    </button>
  );
}

function MenuItem({ icon, onClick, children }: { icon: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800" onClick={onClick}>
      <Icon name={icon} size={18} className="text-stone-500" />
      {children}
    </button>
  );
}

/** File della conversazione: di base l'ultima versione; la storia (versione, data, mittente) si espande. */
function Attachments({ d }: { d: ConversationDetail }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  return (
    <ul className="space-y-1.5 rounded-md bg-stone-100 p-2 text-xs dark:bg-stone-800/60">
      {d.files.map((f) => (
        <FileRow key={f.key} f={f} conversationId={d.id} history={openFile === f.key} onToggleHistory={() => setOpenFile(openFile === f.key ? null : f.key)} />
      ))}
    </ul>
  );
}

function FileRow({ f, conversationId, history, onToggleHistory }: { f: ConversationDetail['files'][number]; conversationId: string; history: boolean; onToggleHistory: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const who = (p: PersonRef | null) => (p ? personLabel(p) : 'sconosciuto');
  const multi = f.versions.length > 1;
  const download = (attachmentId: string) => {
    const a = document.createElement('a');
    a.href = `/api/attachments/${attachmentId}`;
    a.click();
  };
  const ctx = useContextMenu(() => ({
    title: f.name,
    actions: [
      { id: 'download', icon: 'download', label: multi ? `Scarica l'ultima versione (v${f.latest.no})` : 'Scarica', primary: true, run: () => download(f.latest.attachmentId) },
      ...(multi ? [{ id: 'history', icon: 'history', label: history ? 'Nascondi storia' : 'Storia versioni', primary: true, run: onToggleHistory }] : []),
      {
        id: 'resource', icon: 'inventory_2', label: 'Salva come risorsa', primary: true,
        run: async () => {
          await api.attachmentToResource(f.latest.attachmentId);
          for (const k of [['conversations'], ['conversation', conversationId]]) qc.invalidateQueries({ queryKey: k });
          toast({ text: `«${f.name}» salvato tra le risorse` });
        },
      },
      ...f.versions.slice(1).map((v) => ({ id: `v${v.no}`, icon: 'download', label: `Scarica v${v.no} (${shortDate(v.date)}, ${who(v.from)})`, keywords: 'versione', run: () => download(v.attachmentId) })),
    ],
  }));
  return (
    <li>
      <div className="flex items-center gap-2" {...ctx} tabIndex={0}>
        <Icon name="description" size={16} className="shrink-0 text-stone-400" />
        <a className="min-w-0 flex-1 truncate font-medium hover:underline" href={`/api/attachments/${f.latest.attachmentId}`} title="Scarica l'ultima versione">
          {f.name}
        </a>
        {multi && (
          <button
            className={`shrink-0 rounded px-1.5 ${history ? 'bg-stone-300 dark:bg-stone-600' : 'bg-stone-200 hover:bg-stone-300 dark:bg-stone-700'}`}
            onClick={onToggleHistory}
            title="Storia delle versioni"
          >
            v{f.latest.no} · {f.versions.length} versioni
          </button>
        )}
      </div>
      <div className="pl-6 text-stone-500">
        {who(f.latest.from)} · {shortDate(f.latest.date)} · {fileSize(f.latest.size)}
      </div>
      {history && (
        <ol className="ml-6 mt-1 space-y-1 border-l-2 border-stone-300 pl-3 dark:border-stone-600">
          {f.versions.map((v) => (
            <li key={v.attachmentId}>
              <div className="flex items-center gap-2">
                <span className={`shrink-0 font-semibold ${v.no === f.latest.no ? 'text-sky-700 dark:text-sky-300' : ''}`}>v{v.no}</span>
                <span className="min-w-0 flex-1 truncate">
                  {shortDate(v.date)} · {who(v.from)} · {fileSize(v.size)}
                </span>
                <a className="shrink-0 text-stone-500 hover:text-stone-900 dark:hover:text-stone-100" href={`/api/attachments/${v.attachmentId}`} title={`Scarica v${v.no}`}>
                  <Icon name="download" size={16} />
                </a>
              </div>
              {v.filename && v.filename !== f.name && <div className="truncate pl-6 text-stone-400">{v.filename}</div>}
              {v.resent.map((r) => (
                <div key={r.attachmentId} className="pl-6 text-stone-400">
                  rinviato da {who(r.from)} · {shortDate(r.date)}
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

const MAX_INDENT = 5;

/** Albero: dal messaggio più vecchio (radice) ai più recenti; i figli rientrano rispetto al padre. */
function MessageTree({ messages, selectedId, onOpen, conversation, pane }: {
  messages: MessageDto[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  conversation: ConversationDetail;
  pane: PaneAction;
}) {
  const children = new Map<string | null, MessageDto[]>();
  for (const m of messages) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m]);
  const ordered: { m: MessageDto; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const m of (children.get(parent) ?? []).sort((a, b) => a.date - b.date)) {
      ordered.push({ m, depth });
      walk(m.id, depth + 1);
    }
  };
  walk(null, 0);

  return (
    <ul className="pb-2 pl-12 pr-4">
      {ordered.map(({ m, depth }) => (
        <MessageNode key={m.id} m={m} depth={depth} selected={selectedId === m.id} onOpen={() => onOpen(m.id)} conversation={conversation} pane={pane} />
      ))}
    </ul>
  );
}

function MessageNode({ m, depth, selected, onOpen, conversation, pane }: {
  m: MessageDto;
  depth: number;
  selected: boolean;
  onOpen: () => void;
  conversation: ConversationDetail;
  pane: PaneAction;
}) {
  const toast = useToast();
  const unread = !m.seen && m.direction === 'in';
  const who = m.direction === 'out' ? 'Io' : m.from ? personLabel(m.from) : 'sconosciuto';
  const ctx = useContextMenu(() => ({
    title: `${who} · ${shortDate(m.date)}`,
    actions: [
      { id: 'open', icon: 'mail', label: 'Apri', run: onOpen },
      { id: 'reply-all', icon: 'reply_all', label: 'Rispondi a tutti', primary: true, run: () => pane.compose({ replyTo: m, replyAll: true, projectId: conversation.projectId }) },
      { id: 'reply', icon: 'reply', label: 'Rispondi al mittente', primary: true, run: () => pane.compose({ replyTo: m, replyAll: false, projectId: conversation.projectId }) },
      {
        id: 'task', icon: 'add_task', label: 'Crea task da qui', primary: true,
        run: () =>
          conversation.projectId
            ? pane.openTasks(conversation.projectId, { title: '', conversationId: conversation.id, messageId: m.id })
            : toast({ text: 'I task stanno nei progetti: sposta prima la conversazione in un progetto' }),
      },
      { id: 'note', icon: 'sticky_note_2', label: 'Nuova nota', run: () => pane.openNote(conversation.id, null) },
      {
        id: 'copy', icon: 'content_copy', label: 'Copia testo',
        run: () => void navigator.clipboard.writeText(m.bodyText ?? '').then(() => toast({ text: 'Testo copiato' })),
      },
    ],
  }));
  return (
    <li style={{ paddingLeft: Math.min(depth, MAX_INDENT) * 14 }}>
      <button
        {...ctx}
        onClick={onOpen}
        className={`flex w-full items-center gap-2 border-l-2 py-1 pl-2 pr-1 text-left text-xs ${
          selected ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40' : 'border-stone-200 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
        }`}
      >
        {unread && <span className="size-2 shrink-0 rounded-full bg-blue-600" aria-label="non letto" />}
        <span className={`shrink-0 ${unread ? 'font-semibold' : 'font-medium'}`}>{who}</span>
        <span className="min-w-0 flex-1 truncate text-stone-500">{m.bodyTextClean || m.bodyText}</span>
        {m.outgoingStatus === 'queued' && <span className="shrink-0 text-amber-600">in coda</span>}
        {m.outgoingStatus === 'failed' && <span className="shrink-0 text-rose-600">fallito</span>}
        {m.attachments.some((a) => !a.isInline) && <Icon name="attach_file" size={14} className="text-stone-400" />}
        <span className="shrink-0 tabular-nums text-stone-400">{shortDate(m.date)}</span>
      </button>
    </li>
  );
}
