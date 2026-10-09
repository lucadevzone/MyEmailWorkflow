import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GripHorizontal, Lock, Minus } from 'lucide-react';
import { api } from '../api.ts';
import { shortName } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { GroupBadge, PersonAvatar } from '../ui/People.tsx';
import { useSortable } from '../ui/sortable.ts';
import { useToast } from '../ui/toast.tsx';

/** Barra contatti in modalità gestione (D15): riordino e rimozione dal progetto, applicati con Fine. */
export function RailEditor({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: members } = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api.projectMembers(projectId) });
  const [groups, setGroups] = useState<string[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (members && !groups.length && !people.length) {
      setGroups(members.groups.map((g) => `g:${g.id}`));
      setPeople(members.contacts.map((c) => c.key));
    }
  }, [members, groups.length, people.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDone();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  const visibleGroups = groups.filter((k) => !removed.has(k));
  const visiblePeople = people.filter((k) => !removed.has(k));
  const sortGroups = useSortable(visibleGroups, setGroups, 'y');
  const sortPeople = useSortable(visiblePeople, setPeople, 'y');
  const remove = (key: string) => setRemoved((s) => new Set(s).add(key));

  const apply = async () => {
    setSaving(true);
    try {
      await api.reorderProjectMembers(projectId, [...visibleGroups, ...visiblePeople]);
      for (const key of removed) {
        if (key.startsWith('g:')) await api.removeProjectGroup(projectId, key.slice(2));
        else await api.removeProjectContact(projectId, key.slice(2));
      }
      qc.invalidateQueries({ queryKey: ['project-members', projectId] });
      onDone();
    } catch (err) {
      toast({ text: (err as Error).message });
      setSaving(false);
    }
  };

  const groupById = new Map((members?.groups ?? []).map((g) => [`g:${g.id}`, g]));
  const personByKey = new Map((members?.contacts ?? []).map((c) => [c.key, c]));

  const item = (key: string, sort: ReturnType<typeof useSortable>, bubble: ReactNode, label: string, isGroup: boolean) => (
    <div key={key} className={`pm-rail__editem${sort.itemClass(key)}`} {...sort.itemProps(key)}>
      <span className={`pm-rail__bubble${isGroup ? ' pm-rail__bubble--group' : ''}`}>
        {bubble}
        <button type="button" className="pm-badge-remove" aria-label={`Rimuovi ${label} dal progetto`} onClick={() => remove(key)}>
          <Ic icon={Minus} size={15} />
        </button>
      </span>
      <span className="pm-rail__name">{label}</span>
      <button type="button" className="pm-grip" aria-label={`Sposta ${label} (Alt+frecce)`} title="Trascina per riordinare" {...sort.gripProps(key)}>
        <Ic icon={GripHorizontal} size={15} />
      </button>
    </div>
  );

  return (
    <aside className="pm-rail pm-rail--editing" aria-label="Gestisci persone e gruppi del progetto">
      <span className="pm-label">Gruppi</span>
      <div className="pm-rail__editem">
        <span className="pm-rail__bubble pm-rail__bubble--group">
          <GroupBadge all />
          <span className="pm-badge-lock" title="Fisso">
            <Ic icon={Lock} size={15} />
          </span>
        </span>
        <span className="pm-rail__name pm-rail__name--strong">Tutti</span>
      </div>
      {visibleGroups.map((id) => {
        const g = groupById.get(id);
        if (!g) return null;
        return item(id, sortGroups, <GroupBadge members={g.members.map((m) => ({ name: m.name, email: m.emails[0] ?? m.key }))} />, g.name, true);
      })}
      <span className="pm-rail__sep" aria-hidden="true" />
      <span className="pm-label">Persone</span>
      {visiblePeople.map((id) => {
        const p = personByKey.get(id);
        if (!p) return null;
        const person = { name: p.name, email: p.emails[0] ?? p.key };
        return item(id, sortPeople, <PersonAvatar person={person} avatarUrl={p.avatarUrl} size={44} />, shortName(person), false);
      })}
      <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" style={{ marginTop: 6 }} onClick={() => void apply()} disabled={saving}>
        Fine
      </button>
      <button type="button" className="pm-linkbtn" onClick={onDone}>
        Annulla
      </button>
    </aside>
  );
}
