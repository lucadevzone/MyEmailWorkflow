import { useState, type FormEvent, type MouseEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownUp, Pencil, Plus, Users, X } from 'lucide-react';
import type { GroupDto, PersonDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortName } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { GroupBadge, PersonAvatar } from '../ui/People.tsx';
import { useContextMenu } from '../ui/contextMenu.tsx';

type Pick = { key: string; emails: string[] };

/**
 * Barra contatti del progetto (D4). Un clic su una persona o un gruppo apre una nuova mail indirizzata
 * a loro; con Ctrl/⌘ + clic se ne selezionano più d'uno. "Tutti" = contatti e membri dei gruppi, senza doppioni.
 */
export function Rail({ projectId, filter, onFilter, onCompose, onOpenPerson, onManage }: {
  projectId: string;
  onManage: () => void;
  filter: string | null;
  onFilter: (key: string | null) => void;
  onCompose: (emails: string[]) => void;
  onOpenPerson: (key: string) => void;
}) {
  const qc = useQueryClient();
  const { data: members } = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api.projectMembers(projectId) });
  const [selected, setSelected] = useState<Pick[]>([]);
  const [adding, setAdding] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['project-members', projectId] });
  const removeContact = useMutation({ mutationFn: (id: string) => api.removeProjectContact(projectId, id), onSuccess: refresh });
  const removeGroup = useMutation({ mutationFn: (id: string) => api.removeProjectGroup(projectId, id), onSuccess: refresh });

  const firstEmails = (people: PersonDto[]) => people.map((p) => p.emails[0]).filter((e): e is string => !!e);
  const everyone = [...new Set(firstEmails([...(members?.contacts ?? []), ...(members?.groups ?? []).flatMap((g) => g.members)]))];

  const activate = (e: MouseEvent, pick: Pick) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((s) => (s.some((x) => x.key === pick.key) ? s.filter((x) => x.key !== pick.key) : [...s, pick]));
      return;
    }
    const emails = [...new Set([...selected.flatMap((s) => s.emails), ...pick.emails])];
    setSelected([]);
    if (emails.length) onCompose(emails);
  };
  const isSel = (key: string) => selected.some((s) => s.key === key) || filter === key;

  return (
    <aside className="pm-rail" aria-label="Persone del progetto">
      <div className="pm-rail__compose">
        <Ic icon={Pencil} size={15} />
        <span className="pm-rail__compose-title">Nuova mail</span>
        <span className="pm-rail__compose-hint">clicca a chi scrivere</span>
        {selected.length > 0 && (
          <button
            type="button"
            className="pm-btn pm-btn--primary pm-btn--xs pm-rail__multi"
            onClick={() => {
              onCompose([...new Set(selected.flatMap((s) => s.emails))]);
              setSelected([]);
            }}
          >
            Scrivi a {selected.length}
          </button>
        )}
      </div>

      <span className="pm-label">Gruppi</span>
      <button
        type="button"
        className="pm-rail__item"
        aria-pressed={isSel('all')}
        title={everyone.length ? `Scrivi a tutti (${everyone.length})` : 'Nessuna persona nel progetto: aggiungine con +'}
        onClick={(e) => everyone.length && activate(e, { key: 'all', emails: everyone })}
      >
        <GroupBadge all />
        <span className="pm-rail__name pm-rail__name--strong">Tutti</span>
      </button>
      {members?.groups.map((g) => (
        <GroupItem
          key={g.id}
          g={g}
          pressed={isSel(`g:${g.id}`)}
          onActivate={(e) => activate(e, { key: `g:${g.id}`, emails: firstEmails(g.members) })}
          onFilter={() => onFilter(filter === `g:${g.id}` ? null : `g:${g.id}`)}
          onOpen={() => onOpenPerson(`g:${g.id}`)}
          onRemove={() => removeGroup.mutate(g.id)}
        />
      ))}

      <span className="pm-rail__sep" aria-hidden="true" />
      <span className="pm-label">Persone</span>
      {members?.contacts.map((p) => (
        <PersonItem
          key={p.key}
          p={p}
          pressed={isSel(p.key)}
          onActivate={(e) => activate(e, { key: p.key, emails: firstEmails([p]) })}
          onFilter={() => onFilter(filter === p.key ? null : p.key)}
          onOpen={() => onOpenPerson(p.key)}
          onRemove={() => removeContact.mutate(p.contactId!)}
        />
      ))}

      <button type="button" className="pm-rail__add" aria-label="Aggiungi persona o gruppo" title="Aggiungi persona o gruppo" onClick={() => setAdding(!adding)}>
        <Ic icon={Plus} size={15} />
      </button>
      <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Riordina o rimuovi persone e gruppi" title="Gestisci" onClick={onManage}>
        <Ic icon={ArrowDownUp} size={15} />
      </button>
      {adding && <AddMember projectId={projectId} onDone={() => setAdding(false)} />}
    </aside>
  );
}

interface ItemProps {
  pressed: boolean;
  onActivate: (e: MouseEvent) => void;
  onFilter: () => void;
  onOpen: () => void;
  onRemove: () => void;
}

function PersonItem({ p, pressed, onActivate, onFilter, onOpen, onRemove }: ItemProps & { p: PersonDto }) {
  const person = { name: p.name, email: p.emails[0] ?? p.key };
  const ctx = useContextMenu(() => ({
    title: p.name ?? person.email,
    actions: [
      { id: 'write', icon: 'edit', label: 'Scrivi', primary: true, run: () => onActivate({ metaKey: false, ctrlKey: false } as MouseEvent) },
      { id: 'filter', icon: 'filter_alt', label: pressed ? 'Togli il filtro' : 'Filtra conversazioni', primary: true, run: onFilter },
      { id: 'open', icon: 'badge', label: 'Apri scheda', run: onOpen },
      { id: 'remove', icon: 'person_remove', label: 'Togli dal progetto', tone: 'danger', confirm: { message: `Togliere ${p.name ?? person.email} dal progetto?`, okLabel: 'Togli', danger: true }, run: onRemove },
    ],
  }));
  return (
    <button type="button" className="pm-rail__item" aria-pressed={pressed} title={`${p.name ?? ''} <${person.email}>`} onClick={onActivate} {...ctx}>
      <PersonAvatar person={person} avatarUrl={p.avatarUrl} size={44} />
      <span className="pm-rail__name">{shortName(person)}</span>
    </button>
  );
}

function GroupItem({ g, pressed, onActivate, onFilter, onOpen, onRemove }: ItemProps & { g: GroupDto }) {
  const ctx = useContextMenu(() => ({
    title: g.name,
    actions: [
      { id: 'write', icon: 'edit', label: 'Scrivi a tutti', primary: true, run: () => onActivate({ metaKey: false, ctrlKey: false } as MouseEvent) },
      { id: 'filter', icon: 'filter_alt', label: pressed ? 'Togli il filtro' : 'Filtra conversazioni', primary: true, run: onFilter },
      { id: 'open', icon: 'badge', label: 'Apri gruppo', run: onOpen },
      { id: 'remove', icon: 'group_remove', label: 'Togli dal progetto', tone: 'danger', confirm: { message: `Togliere il gruppo «${g.name}» dal progetto?`, okLabel: 'Togli', danger: true }, run: onRemove },
    ],
  }));
  const members = g.members.map((m) => ({ name: m.name, email: m.emails[0] ?? m.key }));
  return (
    <button type="button" className="pm-rail__item" aria-pressed={pressed} title={`${g.name} · ${g.members.length} persone`} onClick={onActivate} {...ctx}>
      <GroupBadge members={members} />
      <span className="pm-rail__name">{g.name}</span>
    </button>
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
    <>
      <div className="pm-backdrop" onPointerDown={onDone} />
      <div className="pm-popover" style={{ left: 92, bottom: 56 }} role="dialog" aria-label="Aggiungi al progetto">
        <div className="pm-popover__title">
          <span style={{ flex: 1 }}>Aggiungi al progetto</span>
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" onClick={onDone} aria-label="Chiudi">
            <Ic icon={X} size={15} />
          </button>
        </div>
        <input className="pm-input" placeholder="Cerca contatti e gruppi" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {groups.map((g) => (
            <button key={g.id} type="button" className="pm-btn pm-btn--ghost pm-btn--sm" style={{ justifyContent: 'flex-start' }} onClick={() => addGroup.mutate(g.id)}>
              <GroupBadge size={30} members={g.members.map((m) => ({ name: m.name, email: m.emails[0] ?? m.key }))} /> {g.name}
              <span className="pm-muted">· {g.members.length}</span>
            </button>
          ))}
          {contacts.map((c) => (
            <button key={c.key} type="button" className="pm-btn pm-btn--ghost pm-btn--sm" style={{ justifyContent: 'flex-start' }} onClick={() => addContact.mutate({ contactId: c.contactId! })}>
              <PersonAvatar person={{ name: c.name, email: c.emails[0] ?? c.key }} avatarUrl={c.avatarUrl} size={24} />
              <span className="pm-truncate">{c.name}</span>
            </button>
          ))}
          {groups.length + contacts.length === 0 && <span className="pm-muted" style={{ fontSize: 'var(--fs-md)' }}>Nessun contatto o gruppo da aggiungere.</span>}
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <span className="pm-label">Nuovo contatto</span>
          <input className="pm-input" placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="pm-input" placeholder="nome@esempio.it" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <div className="pm-popover__actions">
            <span className="pm-spacer" />
            <button className="pm-btn pm-btn--primary pm-btn--sm" disabled={addContact.isPending}>
              <Ic icon={Users} size={15} /> Aggiungi
            </button>
          </div>
        </form>
        {error && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-md)' }}>{error.message}</div>}
      </div>
    </>
  );
}
