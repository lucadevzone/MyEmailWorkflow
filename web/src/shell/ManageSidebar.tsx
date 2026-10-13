// Modalità Gestione nella barra laterale (UI v2): si trascinano i progetti (anche da una categoria
// all'altra) e le categorie; si creano, rinominano ed eliminano categorie; si rimuovono progetti.
// Tutto resta locale finché non si preme Fine; Annulla o Esc scartano.
//
// La disposizione è una lista piatta: intestazioni di categoria ("c:<id>") e progetti. Un progetto
// appartiene alla categoria dell'intestazione che lo precede; "c:none" (Senza categoria) è sempre ultima.

import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMatch, useNavigate } from 'react-router-dom';
import { ArrowDownUp, GripVertical, Lock, Pencil, Plus, X } from 'lucide-react';
import type { ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useSortable } from '../ui/sortable.ts';
import { useToast } from '../ui/toast.tsx';
import { groupProjects } from './Sidebar.tsx';
import { paths, SYSTEM_INBOX } from './paths.ts';

const NONE = 'c:none';
const isHeader = (id: string) => id.startsWith('c:');

interface Cat {
  id: string;
  name: string;
  isNew?: boolean;
}

/** Blocchi intestazione + progetti, nell'ordine della lista. */
function blocks(flat: string[]): string[][] {
  const out: string[][] = [];
  for (const id of flat) {
    if (isHeader(id) || !out.length) out.push([id]);
    else out[out.length - 1]!.push(id);
  }
  return out;
}

export function ManageSidebar({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const match = useMatch({ path: '/p/:projectId', end: false });
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: api.categories,
  });
  const byId = new Map(projects.map((p) => [p.id, p]));

  const [cats, setCats] = useState<Cat[]>(() => categories.map((c) => ({ id: c.id, name: c.name })));
  const [flat, setFlat] = useState<string[]>(() => {
    const groups = groupProjects(projects, categories);
    const list: string[] = [];
    for (const c of categories) list.push(`c:${c.id}`, ...(groups.find((g) => g.category?.id === c.id)?.projects.map((p) => p.id) ?? []));
    list.push(NONE, ...(groups.find((g) => !g.category)?.projects.map((p) => p.id) ?? []));
    return list;
  });
  const [deletedCats, setDeletedCats] = useState<string[]>([]);
  /** Progetti da rimuovere: true = archivia anche le conversazioni aperte. */
  const [removed, setRemoved] = useState<Map<string, boolean>>(new Map());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  const visible = flat.filter((id) => !removed.has(id));

  const reorder = (next: string[], moved: string) => {
    const all = [...next, ...flat.filter((id) => removed.has(id))];
    if (moved === NONE) return;
    if (!isHeader(moved)) {
      // Un progetto non può stare sopra la prima intestazione: va nella prima categoria.
      if (!isHeader(all[0]!)) {
        const rest = all.filter((x) => x !== moved);
        rest.splice(1, 0, moved);
        return setFlat(rest);
      }
      return setFlat(all);
    }
    // Una categoria si sposta con i suoi progetti; Senza categoria resta in fondo.
    const old = blocks(flat);
    const block = old.find((b) => b[0] === moved)!;
    const headers = all.filter(isHeader).filter((h) => h !== NONE);
    const others = old.filter((b) => b[0] !== moved && b[0] !== NONE);
    let k = headers.indexOf(moved);
    const was = old.findIndex((b) => b[0] === moved);
    // Da tastiera (Alt+↑/↓) ogni pressione scavalca un'intera categoria.
    if (!sort.dragging && k === was) k = all.indexOf(moved) < flat.indexOf(moved) ? k - 1 : k + 1;
    k = Math.max(0, Math.min(others.length, k));
    others.splice(k, 0, block);
    setFlat([...others.flat(), ...old.find((b) => b[0] === NONE)!]);
  };
  const sort = useSortable(visible, reorder, 'y');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || renaming || adding) return;
      if (confirming) setConfirming(null);
      else onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirming, renaming, adding, onDone]);

  const catName = (header: string) => cats.find((c) => `c:${c.id}` === header)?.name ?? '';
  const deleteCat = (header: string) => {
    // I suoi progetti finiscono in Senza categoria.
    const block = blocks(flat).find((b) => b[0] === header)!;
    setFlat([...flat.filter((id) => !block.includes(id)), ...block.slice(1)]);
    const id = header.slice(2);
    setCats((cs) => cs.filter((c) => c.id !== id));
    if (!cats.find((c) => c.id === id)?.isNew) setDeletedCats((d) => [...d, id]);
  };
  const addCat = (name: string) => {
    const id = `new-${Date.now()}`;
    setCats((cs) => [...cs, { id, name, isNew: true }]);
    const i = flat.indexOf(NONE);
    setFlat([...flat.slice(0, i), `c:${id}`, ...flat.slice(i)]);
  };

  const apply = async () => {
    setSaving(true);
    try {
      const ids = new Map<string, string>();
      for (const c of cats) {
        if (c.isNew) ids.set(c.id, (await api.createCategory(c.name)).id);
        else if (c.name !== categories.find((x) => x.id === c.id)?.name) await api.updateCategory(c.id, { name: c.name });
      }
      const real = (id: string) => ids.get(id) ?? id;
      let current: string | null = null;
      const layoutProjects: { id: string; categoryId: string | null }[] = [];
      for (const id of visible) {
        if (isHeader(id)) current = id === NONE ? null : real(id.slice(2));
        else layoutProjects.push({ id, categoryId: current });
      }
      await api.saveProjectLayout({
        categories: visible.filter((id) => isHeader(id) && id !== NONE).map((id) => real(id.slice(2))),
        projects: layoutProjects,
      });
      for (const id of deletedCats) await api.deleteCategory(id);
      let moved = 0;
      let archived = 0;
      for (const [id, archiveOpen] of removed) {
        const r = await api.removeProject(id, archiveOpen);
        moved += r.movedConversations;
        archived += r.archived;
      }
      for (const k of [['conversations'], ['counts']]) qc.invalidateQueries({ queryKey: k });
      // Si esce dalla modalità con la barra già aggiornata, senza vedere per un attimo quella vecchia.
      await Promise.all([qc.refetchQueries({ queryKey: ['projects'] }), qc.refetchQueries({ queryKey: ['categories'] })]);
      if (removed.size) {
        toast({
          text: `${removed.size === 1 ? 'Progetto rimosso' : `${removed.size} progetti rimossi`}: ${moved} conversazioni tornate in Da smistare${archived ? ` (${archived} archiviate)` : ''}`,
        });
      }
      if (match?.params.projectId && removed.has(match.params.projectId)) navigate(paths.project(SYSTEM_INBOX));
      onDone();
    } catch (err) {
      toast({ text: (err as Error).message });
      setSaving(false);
    }
  };

  const project = (p: ProjectDto) => (
    <Fragment key={p.id}>
      <li className={`pm-manage__item${sort.itemClass(p.id)}`} {...sort.itemProps(p.id)}>
        <button
          type="button"
          className="pm-grip"
          aria-label={`Sposta ${p.name} (Alt+frecce)`}
          title="Trascina per riordinare o cambiare categoria"
          {...sort.gripProps(p.id)}
        >
          <Ic icon={GripVertical} size={15} />
        </button>
        <span className="pm-manage__name">{p.name}</span>
        <button
          type="button"
          className="pm-tabchip__remove"
          aria-label={`Rimuovi progetto ${p.name}`}
          aria-expanded={confirming === p.id}
          onClick={() => setConfirming(confirming === p.id ? null : p.id)}
        >
          <Ic icon={X} size={15} />
        </button>
      </li>
      {confirming === p.id && (
        <li>
          <RemoveConfirm
            project={p}
            onCancel={() => setConfirming(null)}
            onConfirm={(archiveOpen) => {
              setRemoved((m) => new Map(m).set(p.id, archiveOpen));
              setConfirming(null);
            }}
          />
        </li>
      )}
    </Fragment>
  );

  return (
    <nav className="pm-sidebar pm-sidebar--manage" aria-label="Gestisci progetti">
      <div className="pm-sidebar__head">
        <Ic icon={ArrowDownUp} size={15} />
        <span className="pm-manage__title">Gestisci progetti</span>
        <span className="pm-spacer" />
        <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={onDone}>
          Annulla
        </button>
        <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => void apply()} disabled={saving}>
          Fine
        </button>
      </div>
      <div className="pm-sidebar__body">
        <div className="pm-manage__locked">
          <Ic icon={Lock} size={14} /> Da smistare
        </div>
        <ul className="pm-manage__list">
          {visible.map((id) => {
            if (!isHeader(id)) {
              const p = byId.get(id);
              return p ? project(p) : null;
            }
            if (id === NONE) {
              return (
                <li key={id} className={`pm-manage__cat pm-manage__cat--none${sort.itemClass(id)}`} {...sort.itemProps(id)} draggable={false}>
                  <span className="pm-sidebar__catname">Senza categoria</span>
                </li>
              );
            }
            return (
              <li key={id} className={`pm-manage__cat${sort.itemClass(id)}`} {...sort.itemProps(id)}>
                <button
                  type="button"
                  className="pm-grip"
                  aria-label={`Sposta la categoria ${catName(id)} (Alt+frecce)`}
                  title="Trascina per riordinare"
                  {...sort.gripProps(id)}
                >
                  <Ic icon={GripVertical} size={15} />
                </button>
                {renaming === id ? (
                  <NameInput
                    initial={catName(id)}
                    onDone={(name) => {
                      if (name) setCats((cs) => cs.map((c) => (`c:${c.id}` === id ? { ...c, name } : c)));
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="pm-sidebar__catname">{catName(id)}</span>
                )}
                <button
                  type="button"
                  className="pm-tabchip__remove pm-tabchip__edit"
                  aria-label={`Rinomina la categoria ${catName(id)}`}
                  onClick={() => setRenaming(id)}
                >
                  <Ic icon={Pencil} size={14} />
                </button>
                <button
                  type="button"
                  className="pm-tabchip__remove"
                  aria-label={`Elimina la categoria ${catName(id)} (i progetti restano, senza categoria)`}
                  title="Elimina la categoria: i suoi progetti restano, senza categoria"
                  onClick={() => deleteCat(id)}
                >
                  <Ic icon={X} size={15} />
                </button>
              </li>
            );
          })}
        </ul>
        {adding ? (
          <div className="pm-manage__add">
            <NameInput
              initial=""
              placeholder="Nome della categoria"
              onDone={(name) => {
                if (name) addCat(name);
                setAdding(false);
              }}
            />
          </div>
        ) : (
          <button type="button" className="pm-manage__add" onClick={() => setAdding(true)}>
            <Ic icon={Plus} size={15} /> Nuova categoria
          </button>
        )}
        <span className="pm-sidebar__rule" aria-hidden="true" />
        <div className="pm-manage__locked">
          <Ic icon={Lock} size={14} /> News
        </div>
        <div className="pm-manage__locked">
          <Ic icon={Lock} size={14} /> Spam
        </div>
      </div>
    </nav>
  );
}

function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder?: string; onDone: (name: string) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name.trim());
  };
  return (
    <input
      className="pm-input pm-manage__input"
      autoFocus
      value={v}
      placeholder={placeholder}
      aria-label={placeholder ?? 'Nome della categoria'}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish('');
        }
      }}
      onBlur={() => finish(v)}
    />
  );
}

/** Conferma di rimozione: le aperte tornano in Da smistare, oppure si archivia tutto. */
function RemoveConfirm({ project: p, onCancel, onConfirm }: { project: ProjectDto; onCancel: () => void; onConfirm: (archiveOpen: boolean) => void }) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const open = p.conversationCount;
  const archived = p.archivedConversationCount;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return (
    <div className="pm-popover pm-manage__confirm" role="dialog" aria-label={`Rimuovere ${p.name}?`}>
      <div style={{ fontWeight: 600 }}>Rimuovere «{p.name}»?</div>
      <p>
        Contiene {n(open, 'conversazione aperta', 'conversazioni aperte')} e {n(archived, 'archiviata', 'archiviate')}. Note, task e risorse restano nel
        progetto archiviato.
      </p>
      {open > 0 && (
        <fieldset className="pm-manage__choice">
          <label>
            <input type="radio" name={`rm-${p.id}`} checked={!archiveOpen} onChange={() => setArchiveOpen(false)} />
            <span>
              Rimetti le aperte in <strong>Da smistare</strong>
              {archived ? ' (le archiviate restano in Da smistare › Archivio)' : ''}
            </span>
          </label>
          <label>
            <input type="radio" name={`rm-${p.id}`} checked={archiveOpen} onChange={() => setArchiveOpen(true)} />
            <span>
              Archivia tutto: le aperte vanno in <strong>Da smistare › Archivio</strong> e vengono archiviate anche su Gmail
            </span>
          </label>
        </fieldset>
      )}
      <div className="pm-popover__actions">
        <span className="pm-spacer" />
        <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={onCancel} autoFocus>
          Annulla
        </button>
        <button type="button" className="pm-btn pm-btn--danger-solid pm-btn--sm" onClick={() => onConfirm(archiveOpen)}>
          Rimuovi
        </button>
      </div>
    </div>
  );
}
