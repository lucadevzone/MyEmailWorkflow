import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationListItem, GroupDto, PersonDto } from '@mmw/shared';
import { api } from '../api.ts';
import { personLabel, shortDate } from '../lib/format.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Split } from '../ui/Split.tsx';
import { button, input, primary } from '../ui/styles.ts';

type Selection = { kind: 'person'; person: PersonDto } | { kind: 'group'; group: GroupDto | null } | null;

/** Rubrica: gruppi, contatti, indirizzi suggeriti. Clic su una bolla = conversazioni in tutti i progetti. */
export function PeoplePage({ onOpenConversation }: { onOpenConversation: (c: ConversationListItem) => void }) {
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory });
  const [sel, setSel] = useState<Selection>(null);
  const [q, setQ] = useState('');
  const match = (p: PersonDto) => !q || (p.name ?? '').toLowerCase().includes(q.toLowerCase()) || p.emails.some((e) => e.includes(q.toLowerCase()));

  const bubble = (p: PersonDto) => (
    <button key={p.key} onClick={() => setSel({ kind: 'person', person: p })} className="flex w-20 flex-col items-center gap-1 text-center">
      <Avatar name={p.name} email={p.emails[0] ?? p.key} size={48} ring={sel?.kind === 'person' && sel.person.key === p.key} />
      <span className="line-clamp-2 text-xs leading-tight">{p.name ?? p.emails[0]}</span>
    </button>
  );

  const left = (
    <div className="h-full space-y-6 overflow-y-auto p-6">
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">Contatti</h1>
        <input className={`${input} max-w-56`} placeholder="Cerca…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Gruppi</h2>
          <button className="text-xs text-stone-500 hover:underline" onClick={() => setSel({ kind: 'group', group: null })}>
            + nuovo gruppo
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          {(dir?.groups ?? []).map((g) => (
            <button key={g.id} onClick={() => setSel({ kind: 'group', group: g })} className="flex w-20 flex-col items-center gap-1 text-center">
              <span className={`flex size-12 items-center justify-center rounded-full bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-200 ${sel?.kind === 'group' && sel.group?.id === g.id ? 'ring-2 ring-stone-900 ring-offset-2 dark:ring-stone-100' : ''}`}>
                <Icon name="group" />
              </span>
              <span className="line-clamp-2 text-xs leading-tight">{g.name}</span>
            </button>
          ))}
          {dir && dir.groups.length === 0 && <p className="text-sm text-stone-500">Nessun gruppo.</p>}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Contatti</h2>
        <div className="flex flex-wrap gap-3">{(dir?.contacts ?? []).filter(match).map(bubble)}</div>
        {dir && dir.contacts.length === 0 && <p className="text-sm text-stone-500">Nessun contatto confermato: aggiungili dai suggeriti qui sotto.</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Suggeriti</h2>
        <p className="text-xs text-stone-500">Indirizzi con cui hai scambiato posta (escluso il rumore), non ancora tra i contatti.</p>
        <div className="flex flex-wrap gap-3">{(dir?.suggested ?? []).filter(match).map(bubble)}</div>
      </section>
    </div>
  );

  const right = (
    <div className="h-full overflow-y-auto bg-white dark:bg-stone-900">
      {!sel && <div className="flex h-full items-center justify-center text-sm text-stone-400">Seleziona una persona o un gruppo</div>}
      {sel?.kind === 'person' && <PersonDetail key={sel.person.key} person={sel.person} onOpenConversation={onOpenConversation} onChanged={setSel} />}
      {sel?.kind === 'group' && (
        <GroupDetail key={sel.group?.id ?? 'new'} group={sel.group} contacts={dir?.contacts ?? []} onOpenConversation={onOpenConversation} onDone={() => setSel(null)} />
      )}
    </div>
  );

  return <Split storageKey="mmw.split.people" initial={560} left={left} right={right} />;
}

function PersonDetail({ person, onOpenConversation, onChanged }: { person: PersonDto; onOpenConversation: (c: ConversationListItem) => void; onChanged: (s: Selection) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(!person.contactId ? false : false);
  const [name, setName] = useState(person.name ?? '');
  const [emails, setEmails] = useState(person.emails.join(', '));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['directory'] });
    qc.invalidateQueries({ queryKey: ['people'] });
  };
  const save = useMutation({
    mutationFn: () => {
      const list = emails.split(/[,;\s]+/).filter(Boolean);
      return person.contactId ? api.updateContact(person.contactId, { name, emails: list }) : api.createContact({ name: name || list[0]!, emails: list });
    },
    onSuccess: (p) => {
      refresh();
      setEditing(false);
      onChanged({ kind: 'person', person: { ...person, ...p, conversationCount: person.conversationCount } });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteContact(person.contactId!),
    onSuccess: () => {
      refresh();
      onChanged(null);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center gap-4">
        <Avatar name={person.name} email={person.emails[0] ?? person.key} size={56} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{person.name ?? person.emails[0]}</h2>
          <p className="truncate text-sm text-stone-500">{person.emails.join(', ')}</p>
          {!person.contactId && <p className="text-xs text-amber-700 dark:text-amber-400">Non ancora tra i contatti</p>}
        </div>
        {!editing && (
          <button className={person.contactId ? button : primary} onClick={() => setEditing(true)}>
            {person.contactId ? 'Modifica' : 'Aggiungi ai contatti'}
          </button>
        )}
      </div>

      {editing && (
        <form onSubmit={submit} className="space-y-2 rounded-lg border border-stone-200 p-3 dark:border-stone-700">
          <input className={input} placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input className={input} placeholder="Indirizzi, separati da virgola" value={emails} onChange={(e) => setEmails(e.target.value)} />
          <p className="text-xs text-stone-500">Più indirizzi della stessa persona vengono uniti in un unico contatto.</p>
          {(save.error || remove.error) && <div className="text-xs text-rose-600">{((save.error || remove.error) as Error).message}</div>}
          <div className="flex gap-2">
            {person.contactId && (
              <button type="button" className={button} onClick={() => confirm('Eliminare il contatto? Gli indirizzi restano.') && remove.mutate()}>
                Elimina
              </button>
            )}
            <div className="flex-1" />
            <button type="button" className={button} onClick={() => setEditing(false)}>
              Annulla
            </button>
            <button className={primary} disabled={save.isPending}>
              Salva
            </button>
          </div>
        </form>
      )}

      <PersonConversations personKey={person.key} onOpen={onOpenConversation} />
    </div>
  );
}

/** Conversazioni con una persona (o un gruppo), raggruppate per progetto. */
function PersonConversations({ personKey, onOpen }: { personKey: string; onOpen: (c: ConversationListItem) => void }) {
  const { data: convs = [], isLoading } = useQuery({
    queryKey: ['conversations', { view: 'person', person: personKey }],
    queryFn: () => api.conversations({ view: 'person', person: personKey }),
  });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  if (isLoading) return <div className="text-sm text-stone-500">Caricamento…</div>;
  if (!convs.length) return <div className="text-sm text-stone-500">Nessuna conversazione.</div>;

  const groups = new Map<string, ConversationListItem[]>();
  for (const c of convs) {
    const k = c.projectId ?? (c.isNoise ? '__noise' : '__inbox');
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const label = (k: string) => (k === '__inbox' ? 'Da smistare' : k === '__noise' ? 'Rumore' : (projects.find((p) => p.id === k)?.name ?? 'Progetto'));

  return (
    <div className="space-y-4">
      {[...groups].map(([k, list]) => (
        <section key={k} className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            {label(k)} <span className="font-normal">· {list.length}</span>
          </h3>
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {list.map((c) => (
              <li key={c.id}>
                <button className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-stone-50 dark:hover:bg-stone-800" onClick={() => onOpen(c)}>
                  <span className="min-w-0 flex-1 truncate">{c.summary ?? c.subject ?? '(nessun oggetto)'}</span>
                  {c.archived && <span className="text-xs text-stone-400">archiviata</span>}
                  <span className="shrink-0 text-xs text-stone-500">{shortDate(c.lastMessageAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function GroupDetail({ group, contacts, onOpenConversation, onDone }: { group: GroupDto | null; contacts: PersonDto[]; onOpenConversation: (c: ConversationListItem) => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<Set<string>>(new Set(group?.members.map((m) => m.contactId!) ?? []));
  const [editing, setEditing] = useState(!group);
  const refresh = () => qc.invalidateQueries({ queryKey: ['directory'] });
  const save = useMutation({
    mutationFn: () => (group ? api.updateGroup(group.id, name, [...members]) : api.createGroup(name, [...members])),
    onSuccess: () => {
      refresh();
      if (!group) onDone();
      else setEditing(false);
    },
  });
  const remove = useMutation({ mutationFn: () => api.deleteGroup(group!.id), onSuccess: () => { refresh(); onDone(); } });

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center gap-3">
        <span className="flex size-14 items-center justify-center rounded-full bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-200">
          <Icon name="group" size={28} />
        </span>
        <h2 className="flex-1 text-lg font-semibold">{group?.name ?? 'Nuovo gruppo'}</h2>
        {group && !editing && <button className={button} onClick={() => setEditing(true)}>Modifica</button>}
      </div>
      {editing ? (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
          <input className={input} placeholder="Nome del gruppo" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-stone-200 p-2 dark:border-stone-700">
            {contacts.length === 0 && <p className="text-sm text-stone-500">Prima aggiungi qualche contatto.</p>}
            {contacts.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={members.has(c.contactId!)}
                  onChange={(e) => {
                    const next = new Set(members);
                    if (e.target.checked) next.add(c.contactId!);
                    else next.delete(c.contactId!);
                    setMembers(next);
                  }}
                />
                {c.name} <span className="text-stone-500">{c.emails[0]}</span>
              </label>
            ))}
          </div>
          {save.error && <div className="text-xs text-rose-600">{(save.error as Error).message}</div>}
          <div className="flex gap-2">
            {group && <button type="button" className={button} onClick={() => confirm('Eliminare il gruppo?') && remove.mutate()}>Elimina</button>}
            <div className="flex-1" />
            <button type="button" className={button} onClick={() => (group ? setEditing(false) : onDone())}>Annulla</button>
            <button className={primary} disabled={save.isPending}>Salva</button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-sm">{group!.members.map((m) => <span key={m.key} className="rounded-full bg-stone-100 px-2 py-0.5 dark:bg-stone-800">{personLabel({ name: m.name, email: m.emails[0] ?? '' })}</span>)}</div>
          <PersonConversations personKey={`g:${group!.id}`} onOpen={onOpenConversation} />
        </>
      )}
    </div>
  );
}
