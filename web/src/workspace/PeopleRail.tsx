import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { input, primary } from '../ui/styles.ts';

/**
 * Barra del progetto: solo i contatti e i gruppi inseriti nel progetto.
 * Sono scorciatoie: clic = nuova email dal progetto a quella persona (o a tutto il gruppo).
 */
export function PeopleRail({ projectId, onCompose }: { projectId: string; onCompose: (emails: string[]) => void }) {
  const qc = useQueryClient();
  const { data: members } = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api.projectMembers(projectId) });
  const [adding, setAdding] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['project-members', projectId] });
  const removeContact = useMutation({ mutationFn: (id: string) => api.removeProjectContact(projectId, id), onSuccess: refresh });
  const removeGroup = useMutation({ mutationFn: (id: string) => api.removeProjectGroup(projectId, id), onSuccess: refresh });

  // "Tutti": contatti del progetto + membri dei gruppi, senza doppioni.
  const everyone = [
    ...new Set(
      [...(members?.contacts ?? []), ...(members?.groups ?? []).flatMap((g) => g.members)]
        .map((p) => p.emails[0])
        .filter((e): e is string => !!e),
    ),
  ];

  return (
    <aside className="relative flex w-20 shrink-0 flex-col items-center gap-3 overflow-y-auto border-r border-stone-200 py-3 dark:border-stone-800">
      <div className="flex shrink-0 flex-col items-center gap-0.5">
        <button
          onClick={() => everyone.length && onCompose(everyone)}
          disabled={!everyone.length}
          title={everyone.length ? `Scrivi a tutti (${everyone.length}): ${everyone.join(', ')}` : 'Nessun contatto nel progetto: aggiungine con +'}
          className="flex size-12 items-center justify-center rounded-full bg-stone-900 text-white hover:bg-stone-700 disabled:cursor-default disabled:bg-stone-200 disabled:text-stone-400 dark:bg-stone-100 dark:text-stone-900 dark:disabled:bg-stone-800 dark:disabled:text-stone-600"
        >
          <Icon name="groups" size={26} />
        </button>
        <span className="text-[11px] font-medium text-stone-500">Tutti</span>
      </div>
      {members?.groups.map((g) => (
        <Bubble
          key={g.id}
          label={`${g.name} · ${g.members.length} persone — clic per scrivere a tutti`}
          onClick={() => onCompose(g.members.map((m) => m.emails[0]).filter((e): e is string => !!e))}
          onRemove={() => confirm(`Togliere il gruppo «${g.name}» dal progetto?`) && removeGroup.mutate(g.id)}
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-200">
            <Icon name="group" size={24} />
          </span>
        </Bubble>
      ))}
      {members?.contacts.map((p) => (
        <Bubble
          key={p.key}
          label={`${p.name ?? p.emails[0]} <${p.emails[0]}> — clic per scrivere`}
          onClick={() => p.emails[0] && onCompose([p.emails[0]])}
          onRemove={() => confirm(`Togliere ${p.name ?? p.emails[0]} dal progetto?`) && removeContact.mutate(p.contactId!)}
        >
          <Avatar name={p.name} email={p.emails[0] ?? p.key} avatarUrl={p.avatarUrl} size={48} />
        </Bubble>
      ))}
      <button
        className="flex size-12 shrink-0 items-center justify-center rounded-full border border-dashed border-stone-300 text-stone-500 hover:border-stone-500 hover:text-stone-900 dark:border-stone-600 dark:hover:text-stone-100"
        title="Aggiungi un contatto o un gruppo al progetto"
        onClick={() => setAdding(!adding)}
      >
        <Icon name="add" />
      </button>
      {adding && <AddMember projectId={projectId} onDone={() => setAdding(false)} />}
    </aside>
  );
}

function Bubble({ label, onClick, onRemove, children }: { label: string; onClick: () => void; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="group relative shrink-0">
      <button onClick={onClick} title={label} className="rounded-full">
        {children}
      </button>
      <button
        onClick={onRemove}
        title="Togli dal progetto"
        className="absolute -right-1 -top-1 hidden size-5 items-center justify-center rounded-full bg-stone-700 text-white group-hover:flex dark:bg-stone-300 dark:text-stone-900"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Aggiunge al progetto un contatto o un gruppo esistente, oppure un nuovo contatto (nome + email). */
function AddMember({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory });
  const { data: members } = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api.projectMembers(projectId) });
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const done = () => {
    qc.invalidateQueries({ queryKey: ['project-members', projectId] });
    qc.invalidateQueries({ queryKey: ['directory'] });
    onDone();
  };
  const addContact = useMutation({ mutationFn: (input: { contactId?: string; name?: string; email?: string }) => api.addProjectContact(projectId, input), onSuccess: done });
  const addGroup = useMutation({ mutationFn: (groupId: string) => api.addProjectGroup(projectId, groupId), onSuccess: done });

  const ql = q.trim().toLowerCase();
  const inProject = new Set([...(members?.contacts ?? []).map((c) => c.contactId), ...(members?.groups ?? []).map((g) => g.id)]);
  const groups = (dir?.groups ?? []).filter((g) => !inProject.has(g.id) && (!ql || g.name.toLowerCase().includes(ql)));
  const contacts = (dir?.contacts ?? []).filter(
    (c) => !inProject.has(c.contactId) && (!ql || (c.name ?? '').toLowerCase().includes(ql) || c.emails.some((e) => e.includes(ql))),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    addContact.mutate({ name, email });
  };
  const error = (addContact.error || addGroup.error) as Error | null;

  return (
    <div className="fixed left-24 z-30 mt-2 w-72 space-y-2 rounded-lg border border-stone-200 bg-white p-3 shadow-lg dark:border-stone-700 dark:bg-stone-900">
      <div className="flex items-center justify-between text-sm font-medium">
        Aggiungi al progetto
        <button className="text-stone-400 hover:text-stone-900 dark:hover:text-stone-100" onClick={onDone}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <input className={input} placeholder="Cerca contatti e gruppi…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="max-h-56 overflow-y-auto">
        {groups.map((g) => (
          <li key={g.id}>
            <button className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" onClick={() => addGroup.mutate(g.id)}>
              <Icon name="group" size={18} className="text-stone-500" /> {g.name}
              <span className="text-xs text-stone-500">· {g.members.length}</span>
            </button>
          </li>
        ))}
        {contacts.map((c) => (
          <li key={c.key}>
            <button className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" onClick={() => addContact.mutate({ contactId: c.contactId! })}>
              <Avatar name={c.name} email={c.emails[0] ?? c.key} avatarUrl={c.avatarUrl} size={24} />
              <span className="min-w-0 truncate">{c.name}</span>
            </button>
          </li>
        ))}
        {groups.length + contacts.length === 0 && <li className="py-1 text-xs text-stone-500">Nessun contatto o gruppo da aggiungere.</li>}
      </ul>
      <form onSubmit={submit} className="space-y-2 border-t border-stone-200 pt-2 dark:border-stone-700">
        <div className="text-xs text-stone-500">Oppure un nuovo contatto</div>
        <input className={input} placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={input} placeholder="email@esempio.it" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <div className="flex justify-end">
          <button className={primary} disabled={addContact.isPending}>
            Aggiungi
          </button>
        </div>
      </form>
      {error && <div className="text-xs text-rose-600">{error.message}</div>}
    </div>
  );
}
