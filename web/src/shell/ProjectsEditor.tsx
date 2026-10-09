import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMatch, useNavigate } from 'react-router-dom';
import { ArrowRightLeft, GripVertical, Lock, X } from 'lucide-react';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useSortable } from '../ui/sortable.ts';
import { useToast } from '../ui/toast.tsx';
import { paths, SYSTEM_INBOX } from './paths.ts';

/** Barra dei progetti in modalità gestione (D15): riordino e rimozione, applicati con Fine. */
export function ProjectsEditor({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const match = useMatch({ path: '/p/:projectId', end: false });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const active = projects.filter((p) => !p.archived);
  const [order, setOrder] = useState<string[]>(() => active.map((p) => p.id));
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const visible = order.filter((id) => !removed.has(id));
  const sort = useSortable(visible, (next) => setOrder([...next, ...order.filter((id) => removed.has(id))]), 'x');
  const byId = new Map(projects.map((p) => [p.id, p]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') confirming ? setConfirming(null) : onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirming, onDone]);

  const apply = async () => {
    setSaving(true);
    try {
      if (visible.join() !== active.map((p) => p.id).filter((id) => !removed.has(id)).join()) await api.reorderProjects(visible);
      let moved = 0;
      for (const id of removed) moved += (await api.removeProject(id)).movedConversations;
      for (const k of [['projects'], ['conversations'], ['counts']]) qc.invalidateQueries({ queryKey: k });
      if (removed.size) toast({ text: `${removed.size === 1 ? 'Progetto rimosso' : `${removed.size} progetti rimossi`}: ${moved} conversazioni tornate in Da smistare` });
      if (match?.params.projectId && removed.has(match.params.projectId)) navigate(paths.project(SYSTEM_INBOX));
      onDone();
    } catch (err) {
      toast({ text: (err as Error).message });
      setSaving(false);
    }
  };

  const chip = (id: string) => {
    const p = byId.get(id)!;
    return (
      <li key={id} className={`pm-tabchip${sort.itemClass(id)}`} {...sort.itemProps(id)}>
        <button type="button" className="pm-grip" aria-label={`Sposta ${p.name} (Alt+frecce)`} title="Trascina per riordinare" {...sort.gripProps(id)}>
          <Ic icon={GripVertical} size={15} />
        </button>
        <span className="pm-tabchip__name">{p.name}</span>
        <button type="button" className="pm-tabchip__remove" aria-label={`Rimuovi progetto ${p.name}`} aria-expanded={confirming === id} onClick={() => setConfirming(confirming === id ? null : id)}>
          <Ic icon={X} size={15} />
        </button>
        {confirming === id && (
          <div className="pm-popover pm-manage__confirm" role="dialog" aria-label="Conferma rimozione" style={{ position: 'absolute' }}>
            <div style={{ fontWeight: 600 }}>Rimuovere «{p.name}»?</div>
            <p>
              Le sue {p.conversationCount} conversazioni tornano in Da smistare. Note, task e risorse restano archiviati.
            </p>
            <div className="pm-popover__actions">
              <span className="pm-spacer" />
              <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={() => setConfirming(null)} autoFocus>
                Annulla
              </button>
              <button
                type="button"
                className="pm-btn pm-btn--danger-solid pm-btn--sm"
                onClick={() => {
                  setRemoved((s) => new Set(s).add(id));
                  setConfirming(null);
                }}
              >
                Rimuovi
              </button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <header className="pm-topbar pm-topbar--editing">
      <span className="pm-manage__title">
        <Ic icon={ArrowRightLeft} /> Gestisci progetti
      </span>
      <span className="pm-topbar__sep" aria-hidden="true" />
      <ul className="pm-manage__list" aria-label="Progetti in ordine">
        <li className="pm-tabchip pm-tabchip--locked">
          <Ic icon={Lock} size={15} /> Da smistare
        </li>
        <li className="pm-topbar__tabsep" aria-hidden="true" />
        {visible.map(chip)}
        <li className="pm-topbar__tabsep" aria-hidden="true" />
        <li className="pm-tabchip pm-tabchip--locked">
          <Ic icon={Lock} size={15} /> News
        </li>
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" className="pm-btn pm-btn--secondary" onClick={onDone}>
          Annulla
        </button>
        <button type="button" className="pm-btn pm-btn--primary" onClick={() => void apply()} disabled={saving}>
          Fine
        </button>
      </div>
    </header>
  );
}
