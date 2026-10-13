// "Nuova mail ▾" nell'intestazione del progetto (UI v2): sostituisce la barra contatti. Gruppi (squircle)
// e persone del progetto (cerchi); un clic apre una nuova mail indirizzata a loro, Ctrl/⌘ + clic ne
// seleziona più d'uno. Il campo in alto cerca anche fuori dal progetto o accetta un indirizzo.
// L'icona in basso a sinistra passa alla gestione: riordino e rimozione dal progetto, applicati con Fine.

import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRightLeft, ChevronDown, ChevronUp, Lock, Minus, Pencil, Plus, Search, Users } from 'lucide-react';
import type { GroupDto, PersonDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortName } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { GroupBadge, PersonAvatar } from '../ui/People.tsx';
import { useContextMenu } from '../ui/contextMenu.tsx';
import { useSortable } from '../ui/sortable.ts';
import { useToast } from '../ui/toast.tsx';
import { paths } from '../shell/paths.ts';
import { usePeopleSearch } from '../people/usePeopleSearch.ts';

type Pick = { key: string; emails: string[] };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const firstEmails = (people: PersonDto[]) => people.map((p) => p.emails[0]).filter((e): e is string => !!e);
const refOf = (p: PersonDto) => ({ name: p.name, email: p.emails[0] ?? p.key });

export function NewMailMenu({ projectId, onCompose }: { projectId: string; onCompose: (emails: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // I menu contestuali e le conferme stanno fuori dal pannello, ma ne fanno parte.
      if (ref.current?.contains(t) || t.closest('.pm-ctx-layer, .pm-ctx-bar, .pm-ctx-palette, .pm-confirm')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <div className="pm-newmail" ref={ref}>
      <button type="button" className="pm-btn pm-btn--primary" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <Ic icon={Pencil} size={15} /> Nuova mail <Ic icon={open ? ChevronUp : ChevronDown} size={15} />
      </button>
      {open && (
        <NewMailPanel
          projectId={projectId}
          onClose={() => setOpen(false)}
          onCompose={(emails) => {
            setOpen(false);
            onCompose(emails);
          }}
        />
      )}
    </div>
  );
}

function NewMailPanel({ projectId, onClose, onCompose }: { projectId: string; onClose: () => void; onCompose: (emails: string[]) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: members } = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api.projectMembers(projectId) });
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory });
  const [q, setQ] = useState('');
  const found = usePeopleSearch(q);
  const [selected, setSelected] = useState<Pick[]>([]);
  const [mode, setMode] = useState<'write' | 'manage' | 'add'>('write');
  const refresh = () => qc.invalidateQueries({ queryKey: ['project-members', projectId] });
  const removeContact = useMutation({ mutationFn: (id: string) => api.removeProjectContact(projectId, id), onSuccess: refresh });
  const removeGroup = useMutation({ mutationFn: (id: string) => api.removeProjectGroup(projectId, id), onSuccess: refresh });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (mode !== 'write') setMode('write');
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  const groups = members?.groups ?? [];
  const people = members?.contacts ?? [];
  const everyone = [...new Set(firstEmails([...people, ...groups.flatMap((g) => g.members)]))];
  const hasMembers = groups.length + people.length > 0;

  const activate = (e: MouseEvent, pick: Pick) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((s) => (s.some((x) => x.key === pick.key) ? s.filter((x) => x.key !== pick.key) : [...s, pick]));
      return;
    }
    const emails = [...new Set([...selected.flatMap((s) => s.emails), ...pick.emails])];
    if (emails.length) onCompose(emails);
  };
  const isSel = (key: string) => selected.some((s) => s.key === key);
  const openCard = (key: string) => navigate(`${paths.contacts()}?focus=${encodeURIComponent(key)}`);

  if (mode === 'manage' && members) return <ManagePanel projectId={projectId} groups={groups} people={people} onDone={() => setMode('write')} />;
  if (mode === 'add') return <AddMember projectId={projectId} onDone={() => setMode('write')} />;

  // Ricerca: progetto e rubrica, più l'indirizzo scritto a mano.
  const ql = q.trim().toLowerCase();
  const match = (p: PersonDto) => (p.name ?? '').toLowerCase().includes(ql) || p.emails.some((e) => e.toLowerCase().includes(ql));
  const seen = new Set<string>();
  const foundPeople = ql
    ? [...people, ...(dir?.contacts ?? []), ...(dir?.suggested ?? []), ...found].filter((p) => {
        if (seen.has(p.key) || (!match(p) && !found.includes(p))) return false;
        seen.add(p.key);
        return true;
      }).slice(0, 8)
    : [];
  const foundGroups = ql ? [...groups, ...(dir?.groups ?? []).filter((g) => !groups.some((x) => x.id === g.id))].filter((g) => g.name.toLowerCase().includes(ql)) : [];
  const typed = EMAIL.test(q.trim()) && !foundPeople.some((p) => p.emails.includes(ql)) ? q.trim() : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed) onCompose([typed]);
    else if (foundPeople[0]) onCompose(firstEmails([foundPeople[0]]));
  };

  return (
    <div className="pm-popover pm-newmail__panel" role="dialog" aria-label="Scrivi a…">
      <div className="pm-newmail__title">Scrivi a…</div>
      <form className="pm-newmail__search" onSubmit={submit}>
        <Ic icon={Search} size={15} />
        <input autoFocus placeholder="Cerca persona, gruppo o indirizzo" aria-label="Cerca persona, gruppo o indirizzo" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      {ql ? (
        <div className="pm-newmail__results">
          {typed && (
            <button type="button" className="pm-newmail__row" onClick={() => onCompose([typed])}>
              <PersonAvatar person={{ name: null, email: typed }} size={30} />
              <span className="pm-truncate">Scrivi a <strong>{typed}</strong></span>
            </button>
          )}
          {foundGroups.map((g) => (
            <button key={g.id} type="button" className="pm-newmail__row" aria-pressed={isSel(`g:${g.id}`)} onClick={(e) => activate(e, { key: `g:${g.id}`, emails: firstEmails(g.members) })}>
              <GroupBadge size={30} members={g.members.map(refOf)} />
              <span className="pm-truncate">{g.name}</span>
              <span className="pm-muted">· {g.members.length} persone</span>
            </button>
          ))}
          {foundPeople.map((p) => (
            <button key={p.key} type="button" className="pm-newmail__row" aria-pressed={isSel(p.key)} onClick={(e) => activate(e, { key: p.key, emails: firstEmails([p]) })}>
              <PersonAvatar person={refOf(p)} avatarUrl={p.avatarUrl} size={30} />
              <span className="pm-truncate">{p.name ?? p.emails[0]}</span>
              {p.name && <span className="pm-muted pm-truncate">{p.emails[0]}</span>}
            </button>
          ))}
          {!typed && foundGroups.length + foundPeople.length === 0 && <div className="pm-muted pm-newmail__empty">Nessuno trovato. Scrivi un indirizzo completo per mandare a lui.</div>}
        </div>
      ) : (
        <div className="pm-newmail__body">
          <div className="pm-label">Gruppi</div>
          <div className="pm-newmail__grid">
            {hasMembers && (
              <Bubble label="Tutti" strong pressed={isSel('all')} title={`Scrivi a tutti (${everyone.length})`} onClick={(e) => everyone.length && activate(e, { key: 'all', emails: everyone })}>
                <GroupBadge all size={42} />
              </Bubble>
            )}
            {groups.map((g) => (
              <GroupBubble
                key={g.id}
                g={g}
                pressed={isSel(`g:${g.id}`)}
                onActivate={(e) => activate(e, { key: `g:${g.id}`, emails: firstEmails(g.members) })}
                onOpen={() => openCard(`g:${g.id}`)}
                onRemove={() => removeGroup.mutate(g.id)}
              />
            ))}
            <Bubble label="Nuovo" muted title="Crea un gruppo in Contatti e gruppi" onClick={() => navigate(paths.contacts())}>
              <span className="pm-newmail__add pm-newmail__add--group"><Ic icon={Plus} size={15} /></span>
            </Bubble>
          </div>
          <div className="pm-label">Persone del progetto</div>
          <div className="pm-newmail__grid">
            {people.map((p) => (
              <PersonBubble
                key={p.key}
                p={p}
                pressed={isSel(p.key)}
                onActivate={(e) => activate(e, { key: p.key, emails: firstEmails([p]) })}
                onOpen={() => openCard(p.key)}
                onRemove={() => removeContact.mutate(p.contactId!)}
              />
            ))}
            <Bubble label="Aggiungi" muted title="Aggiungi persona o gruppo al progetto" onClick={() => setMode('add')}>
              <span className="pm-newmail__add"><Ic icon={Plus} size={15} /></span>
            </Bubble>
          </div>
        </div>
      )}
      <div className="pm-newmail__foot">
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Riordina o rimuovi persone e gruppi del progetto" title="Gestisci persone e gruppi" disabled={!hasMembers} onClick={() => setMode('manage')}>
          <Ic icon={ArrowRightLeft} size={15} />
        </button>
        <span className="pm-spacer" />
        {selected.length > 0 && (
          <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => onCompose([...new Set(selected.flatMap((s) => s.emails))])}>
            Scrivi a {new Set(selected.flatMap((s) => s.emails)).size === 1 ? '1 persona' : `${new Set(selected.flatMap((s) => s.emails)).size} persone`}
          </button>
        )}
      </div>
    </div>
  );
}

function Bubble({ label, title, pressed, strong, muted, onClick, children, ...rest }: {
  label: string;
  title?: string;
  pressed?: boolean;
  strong?: boolean;
  muted?: boolean;
  onClick: (e: MouseEvent) => void;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <button type="button" className="pm-newmail__bubble" aria-pressed={pressed} title={title} onClick={onClick} {...rest}>
      {children}
      <span className={`pm-newmail__name${strong ? ' pm-newmail__name--strong' : ''}${muted ? ' pm-newmail__name--muted' : ''}`}>{label}</span>
    </button>
  );
}

function PersonBubble({ p, pressed, onActivate, onOpen, onRemove }: { p: PersonDto; pressed: boolean; onActivate: (e: MouseEvent) => void; onOpen: () => void; onRemove: () => void }) {
  const person = refOf(p);
  const ctx = useContextMenu(() => ({
    title: p.name ?? person.email,
    actions: [
      { id: 'write', icon: 'edit', label: 'Scrivi', primary: true, run: () => onActivate({ metaKey: false, ctrlKey: false } as MouseEvent) },
      { id: 'open', icon: 'badge', label: 'Apri scheda', primary: true, run: onOpen },
      { id: 'remove', icon: 'person_remove', label: 'Togli dal progetto', tone: 'danger', confirm: { message: `Togliere ${p.name ?? person.email} dal progetto?`, okLabel: 'Togli', danger: true }, run: onRemove },
    ],
  }));
  return (
    <Bubble label={shortName(person)} pressed={pressed} title={`${p.name ?? ''} <${person.email}>`} onClick={onActivate} {...ctx}>
      <PersonAvatar person={person} avatarUrl={p.avatarUrl} size={44} />
    </Bubble>
  );
}

function GroupBubble({ g, pressed, onActivate, onOpen, onRemove }: { g: GroupDto; pressed: boolean; onActivate: (e: MouseEvent) => void; onOpen: () => void; onRemove: () => void }) {
  const ctx = useContextMenu(() => ({
    title: g.name,
    actions: [
      { id: 'write', icon: 'edit', label: 'Scrivi a tutti', primary: true, run: () => onActivate({ metaKey: false, ctrlKey: false } as MouseEvent) },
      { id: 'open', icon: 'badge', label: 'Apri gruppo', primary: true, run: onOpen },
      { id: 'remove', icon: 'group_remove', label: 'Togli dal progetto', tone: 'danger', confirm: { message: `Togliere il gruppo «${g.name}» dal progetto?`, okLabel: 'Togli', danger: true }, run: onRemove },
    ],
  }));
  return (
    <Bubble label={g.name} pressed={pressed} title={`${g.name} · ${g.members.length} persone`} onClick={onActivate} {...ctx}>
      <GroupBadge size={42} members={g.members.map(refOf)} />
    </Bubble>
  );
}

/** Gestione: riordino (trascinando o con Alt+←/→) e rimozione dal progetto, applicati con Fine. */
function ManagePanel({ projectId, groups, people, onDone }: { projectId: string; groups: GroupDto[]; people: PersonDto[]; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [gOrder, setGOrder] = useState(() => groups.map((g) => `g:${g.id}`));
  const [pOrder, setPOrder] = useState(() => people.map((p) => p.key));
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const visibleG = gOrder.filter((k) => !removed.has(k));
  const visibleP = pOrder.filter((k) => !removed.has(k));
  const sortG = useSortable(visibleG, (next) => setGOrder([...next, ...gOrder.filter((k) => removed.has(k))]), 'x');
  const sortP = useSortable(visibleP, (next) => setPOrder([...next, ...pOrder.filter((k) => removed.has(k))]), 'x');
  const groupBy = new Map(groups.map((g) => [`g:${g.id}`, g]));
  const personBy = new Map(people.map((p) => [p.key, p]));

  const apply = async () => {
    setSaving(true);
    try {
      await api.reorderProjectMembers(projectId, [...visibleG, ...visibleP]);
      for (const key of removed) {
        if (key.startsWith('g:')) await api.removeProjectGroup(projectId, key.slice(2));
        else await api.removeProjectContact(projectId, personBy.get(key)?.contactId ?? key.slice(2));
      }
      await qc.refetchQueries({ queryKey: ['project-members', projectId] });
      onDone();
    } catch (err) {
      toast({ text: (err as Error).message });
      setSaving(false);
    }
  };

  const item = (key: string, sort: ReturnType<typeof useSortable>, bubble: ReactNode, label: string, isGroup: boolean) => (
    <div key={key} className={`pm-newmail__bubble pm-newmail__bubble--edit${sort.itemClass(key)}`} {...sort.itemProps(key)}>
      <span className={`pm-rail__bubble${isGroup ? ' pm-rail__bubble--group' : ''}`}>
        {bubble}
        <button type="button" className="pm-badge-remove" aria-label={`Togli ${label} dal progetto`} onClick={() => setRemoved((s) => new Set(s).add(key))}>
          <Ic icon={Minus} size={15} />
        </button>
      </span>
      <button type="button" className="pm-grip pm-newmail__grip" aria-label={`Sposta ${label} (Alt+frecce)`} title="Trascina per riordinare" {...sort.gripProps(key)}>
        <span className="pm-newmail__name">{label}</span>
      </button>
    </div>
  );

  return (
    <div className="pm-popover pm-newmail__panel pm-newmail__panel--manage" role="dialog" aria-label="Gestisci persone e gruppi del progetto">
      <div className="pm-newmail__title">Gestisci persone e gruppi</div>
      <p className="pm-muted pm-newmail__hint">Trascina per riordinare; il segno meno toglie dal progetto (il contatto resta in rubrica).</p>
      <div className="pm-newmail__body">
        <div className="pm-label">Gruppi</div>
        <div className="pm-newmail__grid">
          <div className="pm-newmail__bubble pm-newmail__bubble--edit">
            <span className="pm-rail__bubble pm-rail__bubble--group">
              <GroupBadge all size={42} />
              <span className="pm-badge-lock" title="Fisso"><Ic icon={Lock} size={12} /></span>
            </span>
            <span className="pm-newmail__name pm-newmail__name--strong">Tutti</span>
          </div>
          {visibleG.map((k) => {
            const g = groupBy.get(k);
            return g ? item(k, sortG, <GroupBadge size={42} members={g.members.map(refOf)} />, g.name, true) : null;
          })}
        </div>
        <div className="pm-label">Persone del progetto</div>
        <div className="pm-newmail__grid">
          {visibleP.map((k) => {
            const p = personBy.get(k);
            return p ? item(k, sortP, <PersonAvatar person={refOf(p)} avatarUrl={p.avatarUrl} size={44} />, shortName(refOf(p)), false) : null;
          })}
        </div>
      </div>
      <div className="pm-newmail__foot">
        <span className="pm-spacer" />
        <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={onDone}>Annulla</button>
        <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => void apply()} disabled={saving}>Fine</button>
      </div>
    </div>
  );
}

/** Aggiunge al progetto un contatto o un gruppo esistente, oppure un nuovo contatto. */
function AddMember({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory });
  const { data: members } = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api.projectMembers(projectId) });
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const done = () => {
    for (const k of [['project-members', projectId], ['directory']]) qc.invalidateQueries({ queryKey: k });
    onDone();
  };
  const addContact = useMutation({ mutationFn: (input: { contactId?: string; name?: string; email?: string }) => api.addProjectContact(projectId, input), onSuccess: done });
  const addGroup = useMutation({ mutationFn: (groupId: string) => api.addProjectGroup(projectId, groupId), onSuccess: done });
  const ql = q.trim().toLowerCase();
  const inProject = new Set([...(members?.contacts ?? []).map((c) => c.contactId), ...(members?.groups ?? []).map((g) => g.id)]);
  const groups = (dir?.groups ?? []).filter((g) => !inProject.has(g.id) && (!ql || g.name.toLowerCase().includes(ql)));
  const contacts = (dir?.contacts ?? []).filter((c) => !inProject.has(c.contactId) && (!ql || (c.name ?? '').toLowerCase().includes(ql) || c.emails.some((e) => e.includes(ql))));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    addContact.mutate({ name, email });
  };
  const error = (addContact.error || addGroup.error) as Error | null;

  return (
    <div className="pm-popover pm-newmail__panel" role="dialog" aria-label="Aggiungi al progetto">
      <div className="pm-newmail__title">Aggiungi al progetto</div>
      <input className="pm-input" placeholder="Cerca contatti e gruppi" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="pm-newmail__results">
        {groups.map((g) => (
          <button key={g.id} type="button" className="pm-newmail__row" onClick={() => addGroup.mutate(g.id)}>
            <GroupBadge size={30} members={g.members.map(refOf)} /> <span className="pm-truncate">{g.name}</span>
            <span className="pm-muted">· {g.members.length}</span>
          </button>
        ))}
        {contacts.map((c) => (
          <button key={c.key} type="button" className="pm-newmail__row" onClick={() => addContact.mutate({ contactId: c.contactId! })}>
            <PersonAvatar person={refOf(c)} avatarUrl={c.avatarUrl} size={30} />
            <span className="pm-truncate">{c.name ?? c.emails[0]}</span>
          </button>
        ))}
        {groups.length + contacts.length === 0 && <span className="pm-muted pm-newmail__empty">Nessun contatto o gruppo da aggiungere.</span>}
      </div>
      <form onSubmit={submit} className="pm-newmail__newcontact">
        <span className="pm-label">Nuovo contatto</span>
        <input className="pm-input" placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="pm-input" placeholder="nome@esempio.it" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        {error && <div className="pm-error">{error.message}</div>}
        <div className="pm-newmail__foot">
          <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={onDone}>Indietro</button>
          <span className="pm-spacer" />
          <button className="pm-btn pm-btn--primary pm-btn--sm" disabled={addContact.isPending}>
            <Ic icon={Users} size={15} /> Aggiungi
          </button>
        </div>
      </form>
    </div>
  );
}
