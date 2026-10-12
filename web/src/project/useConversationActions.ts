import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationListItem, SuggestionDto } from '@mmw/shared';
import { api } from '../api.ts';
import { personLabel } from '../lib/format.ts';
import { useToast } from '../ui/toast.tsx';
import type { MenuAction } from '../ui/contextMenu.tsx';
import type { ComposeRequest } from '../workspace/pane.ts';
import { projectKeyOf } from '../shell/paths.ts';
import { useDetach } from './useDetach.ts';
import { openSenderRule } from '../rules/SenderRuleDialog.tsx';
import { openRelatedArchive, openRelatedMove } from '../rules/RelatedMoveDialog.tsx';

export interface ConversationHandlers {
  compose: (r: ComposeRequest) => void;
  newTask: () => void;
  newNote: () => void;
  uploadResource: () => void;
  toggleFocus: () => void;
  openMove: () => void;
  createProjectFrom: (sug: SuggestionDto) => void;
}

/** Operazioni su una conversazione condivise da scheda compressa, scheda in focus e menu contestuale. */
export function useConversationActions(c: ConversationListItem, h: ConversationHandlers) {
  const detacher = useDetach();
  // Conversazione in Da smistare (non News né Spam): dopo uno spostamento si propongono le simili.
  const fromInbox = !c.projectId && !c.isNoise && !c.isSpam;
  const qc = useQueryClient();
  const toast = useToast();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const refresh = () => {
    for (const k of [['conversations'], ['conversation', c.id], ['counts'], ['projects'], ['tasks']]) qc.invalidateQueries({ queryKey: k });
  };
  const loadDetail = () => qc.fetchQuery({ queryKey: ['conversation', c.id], queryFn: () => api.conversation(c.id) });
  const undoActivities = (ids: string[]) => () => void Promise.all(ids.map(api.cancelActivity)).then(refresh);

  const reply = async () => {
    const d = await loadDetail();
    const last = d.messages[d.messages.length - 1];
    if (last) h.compose({ replyTo: last, replyAll: true, projectId: d.projectId });
  };
  const archive = useMutation({
    mutationFn: () => api.archive(c.id),
    onSuccess: (res) => {
      refresh();
      toast({ text: 'Conversazione archiviata', action: { label: 'Annulla', run: undoActivities(res.activityIds) } });
      openRelatedArchive(c.id);
    },
  });
  const unarchive = useMutation({ mutationFn: () => api.unarchive(c.id), onSuccess: refresh });
  const trash = useMutation({
    mutationFn: () => api.trash(c.id),
    onSuccess: (res) => {
      refresh();
      toast({ text: 'Spostata nel cestino', action: { label: 'Annulla', run: undoActivities(res.activityIds) } });
    },
  });
  const move = useMutation({
    mutationFn: (projectId: string | null) => api.move(c.id, projectId),
    onSuccess: (res, projectId) => {
      refresh();
      const name = projectId ? projects.find((p) => p.id === projectId)?.name : 'Da smistare';
      toast({ text: `Spostata in ${name}`, action: { label: 'Annulla', run: () => void api.move(c.id, res.previousProjectId).then(refresh) } });
      // Da Da smistare a un progetto: si propongono le altre che potrebbero andarci.
      if (projectId && fromInbox) openRelatedMove(c.id, projectId);
    },
  });
  const unread = useMutation({ mutationFn: () => api.markUnread(c.id), onSuccess: refresh });
  const toProject = useMutation({
    mutationFn: () => api.participantsToProject(c.id, c.subject ?? undefined),
    onSuccess: () => {
      for (const k of [['project-members'], ['directory'], ['people']]) qc.invalidateQueries({ queryKey: k });
      toast({ text: 'Destinatari aggiunti al progetto' });
    },
  });
  const acceptSug = useMutation({
    mutationFn: ({ sug, projectId }: { sug: SuggestionDto; projectId?: string }) => api.acceptSuggestion(sug.id, projectId),
    onSuccess: (res, { sug }) => {
      refresh();
      const ids = (res as { activityIds?: string[] }).activityIds;
      if (sug.kind === 'project') {
        toast({ text: `Spostata in ${sug.payload.projectName}`, action: { label: 'Annulla', run: () => void api.move(c.id, null).then(refresh) } });
        const target = (sug.payload as { projectId?: string | null }).projectId;
        if (target && fromInbox) openRelatedMove(c.id, target);
      }
      else if (ids?.length) {
        toast({ text: 'Conversazione archiviata', action: { label: 'Annulla', run: undoActivities(ids) } });
        openRelatedArchive(c.id);
      }
    },
  });
  const rejectSug = useMutation({ mutationFn: (sug: SuggestionDto) => api.rejectSuggestion(sug.id), onSuccess: refresh });

  /** Esegue un suggerimento dell'analizzatore. */
  const runSuggestion = async (sug: SuggestionDto, projectId?: string) => {
    const p = sug.payload as { action?: string; draft?: string; messageId?: string };
    if (sug.kind === 'new_project') return h.createProjectFrom(sug);
    if (sug.kind === 'action' && p.action === 'reply') {
      const d = await loadDetail();
      const m = d.messages.find((x) => x.id === p.messageId) ?? d.messages[d.messages.length - 1];
      if (m) h.compose({ replyTo: m, replyAll: true, projectId: d.projectId, draft: p.draft });
      return;
    }
    // "È una news" proposto dall'analizzatore: come l'azione manuale, crea la regola sul mittente.
    if (sug.kind === 'action' && p.action === 'noise') return openSenderRule(c.id, 'news');
    acceptSug.mutate({ sug, projectId });
  };

  const suggestionLabel = (sug: SuggestionDto) => {
    const p = sug.payload as { projectName?: string; title?: string; action?: string; draft?: string; dueDate?: string | null };
    const pct = sug.confidence != null ? ` · ${Math.round(sug.confidence * 100)}%` : '';
    if (sug.kind === 'project') return `Sposta in ${p.projectName}${pct}`;
    if (sug.kind === 'new_project') return `Nuovo progetto «${p.projectName}»`;
    if (sug.kind === 'task') return `+ Task: ${p.title}`;
    if (sug.kind === 'action' && p.action === 'reply') return `Rispondi: «${(p.draft ?? '').replace(/\s+/g, ' ').slice(0, 36)}…»`;
    if (sug.kind === 'action' && p.action === 'archive') return 'Archivia (suggerito)';
    if (sug.kind === 'action' && p.action === 'noise') return 'È una news (suggerito)';
    return null;
  };

  const moveTargets = (): MenuAction[] => [
    ...(c.projectId ? [{ id: 'move-inbox', icon: 'inbox', label: 'Sposta in Da smistare', keywords: 'sposta', run: () => move.mutate(null) }] : []),
    ...projects
      .filter((p) => !p.archived && p.id !== c.projectId)
      .map((p) => ({ id: `move-${p.id}`, icon: 'folder', label: `Sposta in ${p.name}`, keywords: 'sposta progetto', run: () => move.mutate(p.id) })),
  ];

  /** Azioni del menu contestuale: prima le suggerite, poi le principali (barra), poi le altre (palette). */
  const menuSpec = (focused: boolean) => {
    const suggested: MenuAction[] = c.suggestions
      .filter((s) => s.kind !== 'task' || c.projectId)
      .map((s) => ({ s, label: suggestionLabel(s) }))
      .filter((x): x is { s: SuggestionDto; label: string } => !!x.label)
      .map(({ s, label }) => ({ id: s.id, tone: 'ai' as const, icon: 'auto_awesome', label, run: () => runSuggestion(s) }));
    const actions: MenuAction[] = [
      ...suggested,
      { id: 'reply', icon: 'reply_all', label: 'Rispondi', primary: true, run: reply },
      { id: 'move', icon: 'drive_file_move', label: 'Sposta in…', primary: true, keywords: 'progetto', run: h.openMove },
      c.archived
        ? { id: 'unarchive', icon: 'unarchive', label: 'Ripristina', primary: true, run: () => unarchive.mutate() }
        : { id: 'archive', icon: 'archive', label: 'Archivia', primary: true, run: () => archive.mutate() },
      ...moveTargets(),
      ...(c.projectId ? [{ id: 'task', icon: 'add_task', label: 'Nuovo task', run: h.newTask }] : []),
      { id: 'note', icon: 'sticky_note_2', label: 'Nuova nota', run: h.newNote },
      { id: 'upload', icon: 'create_new_folder', label: 'Aggiungi risorsa', keywords: 'carica file', run: h.uploadResource },
      { id: 'unread', icon: 'mark_email_unread', label: 'Segna come non letta', run: () => unread.mutate() },
      ...(c.splitFromId ? [{ id: 'rejoin', icon: 'call_merge', label: "Riunisci alla conversazione d'origine", keywords: 'annulla stacca unisci', run: () => detacher.rejoin(c.id, projectKeyOf(c)) }] : []),
      // News e Spam: ogni scelta diventa una regola sul mittente (con proposta per la posta già arrivata).
      ...(c.isSpam
        ? [{ id: 'not-spam', icon: 'mark_email_unread', label: 'Non è spam', primary: true, run: () => openSenderRule(c.id, 'not_spam') }]
        : !c.projectId
          ? [{ id: 'news', icon: 'newspaper', label: c.isNoise ? 'Non è una News' : 'È una News', run: () => openSenderRule(c.id, c.isNoise ? 'not_news' : 'news') }]
          : []),
      ...(c.projectId && c.participants.length
        ? [{ id: 'members', icon: 'group_add', label: c.participants.length > 1 ? 'Aggiungi i destinatari al progetto come gruppo' : `Aggiungi ${personLabel(c.participants[0]!)} al progetto`, run: () => toProject.mutate() }]
        : []),
      { id: 'toggle', icon: focused ? 'unfold_less' : 'unfold_more', label: focused ? 'Chiudi conversazione' : 'Apri conversazione', run: h.toggleFocus },
      ...(!c.isSpam ? [{ id: 'spam', icon: 'report', label: 'È spam', tone: 'danger' as const, keywords: 'spam indesiderata', run: () => openSenderRule(c.id, 'spam') }] : []),
      { id: 'trash', icon: 'delete', label: 'Cestina', tone: 'danger', keywords: 'elimina', confirm: { message: 'Spostare la conversazione nel cestino?', okLabel: 'Cestina', danger: true }, run: () => trash.mutate() },
    ];
    return { title: c.summary ?? c.subject ?? 'Conversazione', actions };
  };

  return { reply, archive, unarchive, move, moveTargets, menuSpec, runSuggestion, rejectSug, suggestionLabel };
}
