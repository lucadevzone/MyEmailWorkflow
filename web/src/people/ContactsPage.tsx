import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, ChevronDown, ChevronUp, Ellipsis, Pencil, Plus, Search, UserPlus } from 'lucide-react';
import type { ConversationListItem, GroupDto, PeopleDirectoryDto, PersonDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { GroupBadge, PersonAvatar, PersonChip, usePeopleIndex } from '../ui/People.tsx';
import { useConfirm } from '../ui/confirm.tsx';
import { useOpenMenu } from '../ui/contextMenu.tsx';
import { useToast } from '../ui/toast.tsx';
import { prepareAvatar } from '../lib/avatar.ts';

const DRAG_TYPE = 'application/x-mmw-contact';
const personRef = (p: PersonDto) => ({ name: p.name, email: p.emails[0] ?? p.key });
const label = (p: PersonDto) => p.name ?? p.emails[0] ?? '?';

/**
 * S4 · Contatti e gruppi (D13): due pannelli. Un contatto si aggiunge a un gruppo trascinandolo sul gruppo
 * (o da tastiera con "Aggiungi a gruppo…" nel suo menu). "Tutti" non compare: è implicito in ogni progetto.
 */
export function ContactsPage({ focusKey, onOpenConversation }: { focusKey?: string | null; onOpenConversation: (c: ConversationListItem) => void }) {
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory });
  const [selected, setSelected] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // Arrivando da una bolla ("Apri scheda") si apre subito la persona o il gruppo.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!dir || !focusKey || focused.current === focusKey) return;
    focused.current = focusKey;
    if (focusKey.startsWith('g:')) setOpenGroup(focusKey.slice(2));
    else setSelected(focusKey);
    window.setTimeout(() => document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: 'center' }), 50);
  }, [dir, focusKey]);

  return (
    <div className="pm-contacts">
      <header className="pm-contacts__head">
        <h1>Contatti e gruppi</h1>
        <p>Trascina un contatto su un gruppo per aggiungerlo. Le persone sono cerchi, i gruppi sono quadrati arrotondati.</p>
      </header>
      <div className="pm-contacts__grid">
        <ContactsPanel dir={dir} selected={selected} onSelect={setSelected} onOpenConversation={onOpenConversation} />
        <GroupsPanel dir={dir} open={openGroup} onOpen={setOpenGroup} onOpenConversation={onOpenConversation} />
      </div>
    </div>
  );
}

function useProjectNames() {
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  return (id: string) => projects.find((p) => p.id === id)?.name ?? 'Progetto';
}

function useRefreshPeople() {
  const qc = useQueryClient();
  return () => {
    for (const k of [['directory'], ['people'], ['project-members']]) qc.invalidateQueries({ queryKey: k });
  };
}

// ─── Contatti ────────────────────────────────────────────────────────────────

function ContactsPanel({ dir, selected, onSelect, onOpenConversation }: {
  dir?: PeopleDirectoryDto;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onOpenConversation: (c: ConversationListItem) => void;
}) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [showSuggested, setShowSuggested] = useState(false);
  const ql = q.trim().toLowerCase();
  const match = (p: PersonDto) => !ql || (p.name ?? '').toLowerCase().includes(ql) || p.emails.some((e) => e.includes(ql));
  const contacts = (dir?.contacts ?? []).filter(match);
  const suggested = (dir?.suggested ?? []).filter(match);

  return (
    <section className="pm-panel" aria-label="Contatti">
      <div className="pm-panel__head">
        <h2>Contatti · {dir?.contacts.length ?? 0}</h2>
        <label className="pm-panel__search">
          <Ic icon={Search} size={15} />
          <input type="search" placeholder="Cerca contatto" aria-label="Cerca contatto" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => setCreating(true)}>
          <Ic icon={Plus} size={15} /> Nuovo contatto
        </button>
      </div>
      {creating && <ContactForm onDone={() => setCreating(false)} />}
      <div role="listbox" aria-label="Contatti">
        {contacts.map((p) => (
          <ContactRow
            key={p.key}
            p={p}
            dir={dir!}
            selected={selected === p.key}
            onToggle={() => onSelect(selected === p.key ? null : p.key)}
            onOpenConversation={onOpenConversation}
          />
        ))}
        {dir && contacts.length === 0 && <div className="pm-empty">{ql ? 'Nessun contatto trovato.' : 'Nessun contatto: aggiungili dai suggeriti qui sotto.'}</div>}
      </div>
      {suggested.length > 0 && (
        <>
          <button type="button" className="pm-panel__section" aria-expanded={showSuggested || !!ql} onClick={() => setShowSuggested(!showSuggested)}>
            <Ic icon={showSuggested || ql ? ChevronUp : ChevronDown} size={15} />
            Suggeriti · {suggested.length}
            <span className="pm-row__sub">indirizzi con cui hai scambiato posta, non ancora tra i contatti</span>
          </button>
          {(showSuggested || !!ql) &&
            suggested.map((p) => (
              <ContactRow
                key={p.key}
                p={p}
                dir={dir!}
                selected={selected === p.key}
                onToggle={() => onSelect(selected === p.key ? null : p.key)}
                onOpenConversation={onOpenConversation}
              />
            ))}
        </>
      )}
    </section>
  );
}

function ContactRow({ p, dir, selected, onToggle, onOpenConversation }: {
  p: PersonDto;
  dir: PeopleDirectoryDto;
  selected: boolean;
  onToggle: () => void;
  onOpenConversation: (c: ConversationListItem) => void;
}) {
  const people = usePeopleIndex();
  const projectName = useProjectNames();
  const openMenu = useOpenMenu();
  const ask = useConfirm();
  const toast = useToast();
  const refresh = useRefreshPeople();
  const [mode, setMode] = useState<'view' | 'edit' | 'merge' | 'group'>('view');
  const photo = useRef<HTMLInputElement>(null);
  const isMe = p.emails.some((e) => people.isMe(e));
  const projects = p.contactId ? (dir.contactProjects[p.contactId] ?? []) : [];

  const setAvatar = useMutation({
    mutationFn: async (file: File) => api.setAvatar(p.contactId!, await prepareAvatar(file)),
    onSuccess: refresh,
    onError: (e) => toast({ text: (e as Error).message }),
  });
  const removeAvatar = useMutation({ mutationFn: () => api.removeAvatar(p.contactId!), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.deleteContact(p.contactId!), onSuccess: refresh });
  const confirm = useMutation({
    mutationFn: () => api.createContact({ name: p.name || p.emails[0]!, emails: p.emails }),
    onSuccess: () => {
      refresh();
      toast({ text: `${label(p)} aggiunto ai contatti` });
    },
  });

  const menu = (el: HTMLElement) => {
    const open = (m: typeof mode) => {
      if (!selected) onToggle();
      setMode(m);
    };
    openMenu(
      {
        title: label(p),
        actions: p.contactId
          ? [
              { id: 'edit', icon: 'edit', label: 'Modifica', primary: true, run: () => open('edit') },
              { id: 'group', icon: 'group_add', label: 'Aggiungi a gruppo…', primary: true, run: () => open('group') },
              { id: 'photo', icon: 'photo_camera', label: 'Carica foto', run: () => photo.current?.click() },
              ...(p.avatarUrl ? [{ id: 'nophoto', icon: 'hide_image', label: 'Togli la foto', run: () => removeAvatar.mutate() }] : []),
              { id: 'merge', icon: 'merge', label: 'Unisci con…', run: () => open('merge') },
              {
                id: 'delete', icon: 'delete', label: 'Elimina contatto', tone: 'danger' as const,
                run: async () => (await ask({ message: `Eliminare ${label(p)}? Gli indirizzi restano.`, okLabel: 'Elimina', danger: true })) && remove.mutate(),
              },
            ]
          : [{ id: 'add', icon: 'person_add', label: 'Aggiungi ai contatti', primary: true, run: () => confirm.mutate() }],
      },
      el,
      'bar',
    );
  };

  const onDragStart = (e: DragEvent) => {
    if (!p.contactId) return e.preventDefault();
    e.dataTransfer.setData(DRAG_TYPE, p.contactId);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className={`pm-row${selected ? ' pm-row--open' : ''}`} data-key={p.key} aria-selected={selected} role="option">
      <div className="pm-row__line" draggable={!!p.contactId} onDragStart={onDragStart} title={p.contactId ? 'Trascina su un gruppo per aggiungerlo' : undefined}>
        <button type="button" className="pm-row__main" onClick={onToggle} aria-expanded={selected}>
          <PersonAvatar person={personRef(p)} avatarUrl={p.avatarUrl} size={40} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="pm-row__name">
              {label(p)} {isMe && <span className="pm-badge-me">io</span>}
            </span>
            <span className="pm-row__sub pm-truncate">{p.emails.join(', ')}</span>
          </span>
        </button>
        <span className="pm-row__chips">
          {isMe ? (
            <span className="pm-projectlabel">tutti i progetti</span>
          ) : (
            projects.slice(0, 3).map((id) => (
              <span key={id} className="pm-projectlabel">{projectName(id)}</span>
            ))
          )}
          {!isMe && projects.length > 3 && <span className="pm-projectlabel">+{projects.length - 3}</span>}
          {!p.contactId && (
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
              <Ic icon={UserPlus} size={15} /> Aggiungi
            </button>
          )}
        </span>
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Opzioni contatto" onClick={(e) => menu(e.currentTarget)}>
          <Ic icon={Ellipsis} />
        </button>
        <input
          ref={photo}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) setAvatar.mutate(f);
          }}
        />
      </div>
      {selected && (
        <div className="pm-row__detail">
          {mode === 'edit' && <ContactForm person={p} onDone={() => setMode('view')} />}
          {mode === 'merge' && <MergePicker person={p} dir={dir} onDone={() => setMode('view')} />}
          {mode === 'group' && <GroupPicker person={p} dir={dir} onDone={() => setMode('view')} />}
          {mode === 'view' && (
            <div className="pm-row__actions">
              {p.contactId ? (
                <>
                  <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={() => setMode('edit')}>
                    <Ic icon={Pencil} size={15} /> Modifica
                  </button>
                  <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={() => photo.current?.click()}>
                    <Ic icon={Camera} size={15} /> {p.avatarUrl ? 'Cambia foto' : 'Carica foto'}
                  </button>
                  <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={() => setMode('group')}>
                    Aggiungi a gruppo…
                  </button>
                  <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={() => setMode('merge')}>
                    Unisci con…
                  </button>
                </>
              ) : (
                <span className="pm-row__sub">Non ancora tra i contatti: aggiungilo per caricare una foto, metterlo in un gruppo o in un progetto.</span>
              )}
            </div>
          )}
          <Conversations personKey={p.key} onOpen={onOpenConversation} />
        </div>
      )}
    </div>
  );
}

function ContactForm({ person, onDone }: { person?: PersonDto; onDone: () => void }) {
  const refresh = useRefreshPeople();
  const [name, setName] = useState(person?.name ?? '');
  const [emails, setEmails] = useState(person?.emails.join(', ') ?? '');
  const save = useMutation({
    mutationFn: () => {
      const list = emails.split(/[,;\s]+/).filter(Boolean);
      return person?.contactId ? api.updateContact(person.contactId, { name, emails: list }) : api.createContact({ name: name || list[0]!, emails: list });
    },
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form className="pm-inlineform" onSubmit={submit}>
      <input className="pm-input" placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input className="pm-input" placeholder="Indirizzi, separati da virgola" value={emails} onChange={(e) => setEmails(e.target.value)} required />
      <span className="pm-row__sub">Più indirizzi della stessa persona restano un unico contatto.</span>
      {save.error && <span className="pm-draft__error" style={{ padding: 0 }}>{(save.error as Error).message}</span>}
      <span className="pm-inlineform__actions">
        <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={onDone}>Annulla</button>
        <button type="submit" className="pm-btn pm-btn--primary pm-btn--sm" disabled={save.isPending}>Salva</button>
      </span>
    </form>
  );
}

/** Sceglie un'altra persona da unire in questo contatto (che ne prende indirizzi, gruppi e progetti). */
function MergePicker({ person, dir, onDone }: { person: PersonDto; dir: PeopleDirectoryDto; onDone: () => void }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const refresh = useRefreshPeople();
  const [q, setQ] = useState('');
  const merge = useMutation({
    mutationFn: (key: string) => api.mergeContact(person.contactId!, key),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ['conversations'] });
      onDone();
    },
  });
  const ql = q.trim().toLowerCase();
  const list = [...dir.contacts, ...dir.suggested]
    .filter((p) => p.key !== person.key)
    .filter((p) => !ql || (p.name ?? '').toLowerCase().includes(ql) || p.emails.some((e) => e.includes(ql)))
    .slice(0, 12);
  return (
    <div className="pm-inlineform">
      <span className="pm-row__sub">Unisci in «{label(person)}»: l'altro contatto sparisce, i suoi indirizzi, gruppi e progetti passano qui.</span>
      <input className="pm-input" placeholder="Cerca per nome o indirizzo…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="pm-picklist">
        {list.map((p) => (
          <button
            key={p.key}
            type="button"
            className="pm-menu-pop__item"
            disabled={merge.isPending}
            onClick={async () => (await ask({ message: `Unire «${label(p)}» in «${label(person)}»?`, okLabel: 'Unisci', danger: true })) && merge.mutate(p.key)}
          >
            <PersonAvatar person={personRef(p)} avatarUrl={p.avatarUrl} size={24} />
            <span className="pm-truncate" style={{ flex: 1 }}>{label(p)} <span className="pm-row__sub">{p.emails[0]}</span></span>
            {!p.contactId && <span className="pm-row__sub">suggerito</span>}
          </button>
        ))}
      </div>
      <span className="pm-inlineform__actions">
        <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={onDone}>Annulla</button>
      </span>
    </div>
  );
}

/** Alternativa da tastiera al trascinamento: scegli il gruppo. */
function GroupPicker({ person, dir, onDone }: { person: PersonDto; dir: PeopleDirectoryDto; onDone: () => void }) {
  const add = useAddToGroup();
  const free = dir.groups.filter((g) => !g.members.some((m) => m.contactId === person.contactId));
  return (
    <div className="pm-inlineform">
      <span className="pm-row__sub">Aggiungi {label(person)} a un gruppo:</span>
      <div className="pm-picklist">
        {free.length === 0 && <span className="pm-row__sub">È già in tutti i gruppi (o non ci sono gruppi).</span>}
        {free.map((g) => (
          <button key={g.id} type="button" className="pm-menu-pop__item" onClick={() => void add(g, person.contactId!).then(onDone)}>
            <GroupBadge members={g.members.map(personRef)} size={30} />
            <span style={{ flex: 1 }}>{g.name}</span>
          </button>
        ))}
      </div>
      <span className="pm-inlineform__actions">
        <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={onDone}>Chiudi</button>
      </span>
    </div>
  );
}

/** Conversazioni con una persona o un gruppo, in tutti i progetti. */
function Conversations({ personKey, onOpen }: { personKey: string; onOpen: (c: ConversationListItem) => void }) {
  const projectName = useProjectNames();
  const { data: convs = [], isLoading } = useQuery({
    queryKey: ['conversations', { view: 'person', person: personKey }],
    queryFn: () => api.conversations({ view: 'person', person: personKey }),
  });
  if (isLoading) return <div className="pm-row__sub">Caricamento conversazioni…</div>;
  if (!convs.length) return <div className="pm-row__sub">Nessuna conversazione.</div>;
  return (
    <div className="pm-convmini">
      <span className="pm-label">Conversazioni · {convs.length}</span>
      {convs.slice(0, 8).map((c) => (
        <button key={c.id} type="button" className="pm-convmini__item" onClick={() => onOpen(c)}>
          <span className="pm-truncate" style={{ flex: 1 }}>{c.summary ?? c.subject ?? '(nessun oggetto)'}</span>
          <span className="pm-projectlabel">{c.projectId ? projectName(c.projectId) : c.isNoise ? 'News' : 'Da smistare'}</span>
          <span className="pm-row__sub">{shortDate(c.lastMessageAt)}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Gruppi ──────────────────────────────────────────────────────────────────

function useAddToGroup() {
  const refresh = useRefreshPeople();
  const toast = useToast();
  return async (g: GroupDto, contactId: string) => {
    if (g.members.some((m) => m.contactId === contactId)) return;
    await api.updateGroup(g.id, g.name, [...g.members.map((m) => m.contactId!), contactId]);
    refresh();
    toast({ text: `Aggiunto a ${g.name}` });
  };
}

function GroupsPanel({ dir, open, onOpen, onOpenConversation }: {
  dir?: PeopleDirectoryDto;
  open: string | null;
  onOpen: (id: string | null) => void;
  onOpenConversation: (c: ConversationListItem) => void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="pm-panel" aria-label="Gruppi">
      <div className="pm-panel__head">
        <h2>Gruppi · {dir?.groups.length ?? 0}</h2>
        <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => setCreating(true)}>
          <Ic icon={Plus} size={15} /> Nuovo gruppo
        </button>
      </div>
      {creating && <GroupNameForm onDone={() => setCreating(false)} />}
      {dir?.groups.map((g) => (
        <GroupRow key={g.id} g={g} dir={dir} open={open === g.id} onToggle={() => onOpen(open === g.id ? null : g.id)} onOpenConversation={onOpenConversation} />
      ))}
      {dir && dir.groups.length === 0 && !creating && <div className="pm-empty">Nessun gruppo. Creane uno e trascinaci dentro i contatti.</div>}
    </section>
  );
}

function GroupNameForm({ group, onDone }: { group?: GroupDto; onDone: () => void }) {
  const refresh = useRefreshPeople();
  const [name, setName] = useState(group?.name ?? '');
  const save = useMutation({
    mutationFn: () => (group ? api.updateGroup(group.id, name, group.members.map((m) => m.contactId!)) : api.createGroup(name, [])),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  return (
    <form
      className="pm-inlineform pm-inlineform--row"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) save.mutate();
      }}
    >
      <input className="pm-input" placeholder="Nome del gruppo" value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Escape' && onDone()} />
      <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={onDone}>Annulla</button>
      <button type="submit" className="pm-btn pm-btn--primary pm-btn--sm" disabled={save.isPending || !name.trim()}>{group ? 'Rinomina' : 'Crea'}</button>
    </form>
  );
}

function GroupRow({ g, dir, open, onToggle, onOpenConversation }: {
  g: GroupDto;
  dir: PeopleDirectoryDto;
  open: boolean;
  onToggle: () => void;
  onOpenConversation: (c: ConversationListItem) => void;
}) {
  const projectName = useProjectNames();
  const refresh = useRefreshPeople();
  const ask = useConfirm();
  const add = useAddToGroup();
  const [renaming, setRenaming] = useState(false);
  const [over, setOver] = useState(false);
  const used = dir.groupProjects[g.id] ?? [];
  const sub = useMemo(
    () => `${g.members.length} ${g.members.length === 1 ? 'persona' : 'persone'}${used.length ? ` · usato in ${used.map(projectName).join(', ')}` : ''}`,
    [g.members.length, used, projectName],
  );
  const removeMember = async (contactId: string) => {
    await api.updateGroup(g.id, g.name, g.members.map((m) => m.contactId!).filter((id) => id !== contactId));
    refresh();
  };
  const del = async () => {
    if (!(await ask({ message: `Eliminare il gruppo ${g.name}? I contatti restano.`, okLabel: 'Elimina', danger: true }))) return;
    await api.deleteGroup(g.id);
    refresh();
  };
  // Un contatto trascinato sul gruppo (chiuso o aperto) vi viene aggiunto.
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (id) void add(g, id);
    },
  };

  return (
    <div className={`pm-row${open ? ' pm-row--open pm-group-row--open' : ''}${over ? ' pm-row--dropover' : ''}`} data-key={`g:${g.id}`} {...drop}>
      {renaming ? (
        <GroupNameForm group={g} onDone={() => setRenaming(false)} />
      ) : (
        <div className="pm-row__line">
          <button type="button" className="pm-row__main" onClick={onToggle} aria-expanded={open}>
            <GroupBadge members={g.members.map(personRef)} size={42} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="pm-row__name">{g.name}</span>
              <span className="pm-row__sub pm-truncate">{sub}</span>
            </span>
          </button>
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label="Rinomina gruppo" title="Rinomina" onClick={() => setRenaming(true)}>
            <Ic icon={Pencil} size={15} />
          </button>
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" aria-label={open ? 'Comprimi gruppo' : 'Espandi gruppo'} onClick={onToggle}>
            <Ic icon={open ? ChevronUp : ChevronDown} />
          </button>
        </div>
      )}
      {open && (
        <div className="pm-row__detail">
          <div className="pm-group-members">
            {g.members.map((m) => (
              <PersonChip key={m.key} person={personRef(m)} onRemove={() => void removeMember(m.contactId!)} />
            ))}
            <span className="pm-dropzone">+ trascina qui un contatto</span>
          </div>
          <Conversations personKey={`g:${g.id}`} onOpen={onOpenConversation} />
          <div className="pm-row__actions">
            <span style={{ flex: 1 }} />
            <button type="button" className="pm-btn pm-btn--danger pm-btn--xs" onClick={() => void del()}>Elimina gruppo</button>
          </div>
        </div>
      )}
    </div>
  );
}
