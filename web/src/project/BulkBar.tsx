// Azioni su più conversazioni selezionate (caselle di spunta a sinistra delle righe): compare sotto
// l'intestazione del progetto appena se ne seleziona una. "Unisci" richiede almeno due conversazioni.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, FolderInput, Mail, MailOpen, Merge, X } from 'lucide-react';
import type { MenuAction } from '../ui/contextMenu.tsx';
import { useOpenMenu } from '../ui/contextMenu.tsx';
import { useConfirm } from '../ui/confirm.tsx';
import { useToast } from '../ui/toast.tsx';
import { Ic } from '../ui/Ic.tsx';
import { api } from '../api.ts';
import { SYSTEM_INBOX } from '../shell/paths.ts';

export function BulkBar({ ids, projectKey, archivedView, total, onSelectAll, onClear, onMerged }: {
  ids: string[];
  projectKey: string;
  archivedView: boolean;
  /** Conversazioni visibili nella lista (per "Seleziona tutte"). */
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  onMerged: (conversationId: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const openMenu = useOpenMenu();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const n = ids.length;
  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['activities'], ['important-counts']]) void qc.invalidateQueries({ queryKey: k });
  };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      refresh();
      toast({ text: done });
      onClear();
    } catch (e) {
      toast({ text: (e as Error).message });
    }
  };
  const label = (k: number) => (k === 1 ? '1 conversazione' : `${k} conversazioni`);

  const moveTargets = (): MenuAction[] => [
    ...(projectKey !== SYSTEM_INBOX
      ? [{ id: 'inbox', icon: 'inbox', label: 'Da smistare', primary: true, run: () => run(() => Promise.all(ids.map((id) => api.move(id, null))), `${label(n)} in Da smistare`) }]
      : []),
    ...projects
      .filter((p) => !p.archived && p.id !== projectKey)
      .map((p) => ({ id: p.id, icon: 'folder', label: p.name, primary: true, run: () => run(() => api.moveMany(ids, p.id), `${label(n)} spostate in ${p.name}`) })),
  ];

  const merge = async () => {
    const ok = await ask({ message: `Unire le ${n} conversazioni in una sola?`, okLabel: 'Unisci' });
    if (!ok) return;
    try {
      const r = await api.mergeConversations(ids);
      refresh();
      toast({ text: `${label(n)} unite` });
      onClear();
      onMerged(r.conversationId);
    } catch (e) {
      toast({ text: (e as Error).message });
    }
  };

  const archive = async () => {
    try {
      const r = await api.archiveMany(ids);
      refresh();
      toast({
        text: n === 1 ? 'Conversazione archiviata' : `${n} conversazioni archiviate`,
        action: { label: 'Annulla', run: () => void Promise.all(r.activityIds.map(api.cancelActivity)).then(refresh) },
      });
      onClear();
    } catch (e) {
      toast({ text: (e as Error).message });
    }
  };

  return (
    <div className="pm-bulkbar" role="toolbar" aria-label="Azioni sulle conversazioni selezionate">
      <button type="button" className="pm-iconbtn pm-iconbtn--sm" onClick={onClear} aria-label="Deseleziona tutte (Esc)" title="Deseleziona tutte (Esc)">
        <Ic icon={X} size={15} />
      </button>
      <span className="pm-bulkbar__count">{n === 1 ? '1 selezionata' : `${n} selezionate`}</span>
      {n < total && (
        <button type="button" className="pm-linkbtn" onClick={onSelectAll}>
          Seleziona tutte ({total})
        </button>
      )}
      <span className="pm-spacer" />
      <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={() => void run(() => Promise.all(ids.map(api.markRead)), `${label(n)} segnate come lette`)}>
        <Ic icon={MailOpen} size={15} /> Letta
      </button>
      <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={() => void run(() => Promise.all(ids.map(api.markUnread)), `${label(n)} segnate come da leggere`)}>
        <Ic icon={Mail} size={15} /> Da leggere
      </button>
      <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={(e) => openMenu({ title: `Sposta ${label(n)} in`, actions: moveTargets() }, e.currentTarget, 'palette')}>
        <Ic icon={FolderInput} size={15} /> Sposta in…
      </button>
      <button
        type="button"
        className="pm-btn pm-btn--ghost pm-btn--sm"
        disabled={n < 2}
        title={n < 2 ? 'Seleziona almeno due conversazioni da unire' : 'Unisci in una sola conversazione'}
        onClick={() => void merge()}
      >
        <Ic icon={Merge} size={15} /> Unisci
      </button>
      {archivedView ? (
        <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={() => void run(() => Promise.all(ids.map(api.unarchive)), `${label(n)} ripristinate`)}>
          <Ic icon={ArchiveRestore} size={15} /> Ripristina
        </button>
      ) : (
        <button type="button" className="pm-btn pm-btn--danger pm-btn--sm" onClick={() => void archive()}>
          <Ic icon={Archive} size={15} /> Archivia
        </button>
      )}
    </div>
  );
}
