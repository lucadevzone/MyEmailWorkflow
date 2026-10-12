// Dopo aver spostato una conversazione da Da smistare a un progetto, o dopo averla archiviata: le altre
// che probabilmente vanno trattate allo stesso modo (stesso mittente, contenuto simile, già suggerite).
// Si spostano/archiviano tutte insieme o una alla volta; se non ce ne sono, la finestra non compare.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { useToast } from '../ui/toast.tsx';

const EVENT = 'mmw:related-move';

interface Req {
  conversationId: string;
  /** Progetto di destinazione; null = archiviazione. */
  projectId: string | null;
}

/** Da chiamare dopo uno spostamento da Da smistare a un progetto. */
export function openRelatedMove(conversationId: string, projectId: string) {
  window.dispatchEvent(new CustomEvent<Req>(EVENT, { detail: { conversationId, projectId } }));
}

/** Da chiamare dopo un'archiviazione. */
export function openRelatedArchive(conversationId: string) {
  window.dispatchEvent(new CustomEvent<Req>(EVENT, { detail: { conversationId, projectId: null } }));
}

export function RelatedMoveHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<Req>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!req) return null;
  return <RelatedMoveDialog key={`${req.conversationId}-${req.projectId}`} {...req} onClose={() => setReq(null)} />;
}

function RelatedMoveDialog({ conversationId, projectId, onClose }: Req & { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const archive = projectId === null;
  const { data } = useQuery({
    queryKey: ['related-move', conversationId, projectId],
    queryFn: () => (archive ? api.relatedForArchive(conversationId) : api.relatedForMove(conversationId, projectId)),
    staleTime: 0,
  });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projects.find((p) => p.id === projectId)?.name ?? 'progetto';
  const verb = archive ? 'Archivia' : 'Sposta';
  // Spuntate di default: si toglie la spunta solo a quelle da lasciare dove sono.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Nessuna proposta: non si disturba.
  useEffect(() => {
    if (data && data.items.length === 0) onClose();
  }, [data, onClose]);
  if (!data || data.items.length === 0) return null;

  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects']]) qc.invalidateQueries({ queryKey: k });
  };
  const selected = data.items.filter((i) => !unchecked.has(i.conversationId)).map((i) => i.conversationId);
  const toggle = (id: string) =>
    setUnchecked((u) => {
      const n = new Set(u);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const run = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      if (archive) {
        const r = await api.archiveMany(selected);
        toast({
          text: selected.length === 1 ? 'Conversazione archiviata' : `${selected.length} conversazioni archiviate`,
          action: { label: 'Annulla', run: () => void Promise.all(r.activityIds.map(api.cancelActivity)).then(refresh) },
        });
      } else {
        await api.moveMany(selected, projectId);
        toast({ text: selected.length === 1 ? `Spostata in ${project}` : `${selected.length} conversazioni spostate in ${project}` });
      }
      refresh();
      onClose();
    } catch (e) {
      toast({ text: (e as Error).message });
      setBusy(false);
    }
  };

  return (
    <div className="pm-modal" onClick={onClose}>
      <div className="pm-modal__card pm-rule" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={archive ? 'Altre conversazioni da archiviare' : `Altre conversazioni per ${project}`}>
        <h2 className="pm-modal__title">{archive ? 'Archiviare anche queste?' : `Anche queste in ${project}?`}</h2>
        <p>
          {archive ? (
            <>Ci sono altre <strong>{data.items.length}</strong> {data.items.length === 1 ? 'conversazione simile' : 'conversazioni simili'} a quella che hai archiviato.</>
          ) : (
            <>
              In Da smistare ci sono <strong>{data.items.length}</strong> {data.items.length === 1 ? 'conversazione' : 'conversazioni'} che potrebbero andare
              nello stesso progetto.
            </>
          )}
        </p>
        <div className="pm-related__bulk">
          <button type="button" className="pm-linkbtn" onClick={() => setUnchecked(new Set())}>Seleziona tutte</button>
          <button type="button" className="pm-linkbtn" onClick={() => setUnchecked(new Set(data.items.map((i) => i.conversationId)))}>Deseleziona tutte</button>
          <span className="pm-muted">{selected.length} di {data.items.length} selezionate</span>
        </div>
        <ul className="pm-related">
          {data.items.map((i) => (
            <li key={i.conversationId} className={unchecked.has(i.conversationId) ? 'is-off' : ''}>
              <label className="pm-related__row">
                <input type="checkbox" checked={!unchecked.has(i.conversationId)} onChange={() => toggle(i.conversationId)} />
                <span className="pm-related__main">
                  <span className="pm-truncate">{i.subject || '(senza oggetto)'}</span>
                  <span className="pm-muted pm-truncate">
                    {i.from ?? '—'} · {shortDate(i.date)} · {i.reasons.join(', ')}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="pm-inlineform__actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={onClose}>Cancella</button>
          <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" disabled={busy || !selected.length} onClick={() => void run()}>
            {verb} selezionate ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}
