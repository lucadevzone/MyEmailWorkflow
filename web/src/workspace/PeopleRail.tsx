import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { input, primary } from '../ui/styles.ts';

/** Barra verticale con le bolle delle persone della vista; clic = filtra le conversazioni. */
export function PeopleRail({ scope, filter, onFilter }: {
  scope: { view: 'inbox' | 'noise' } | { view: 'project'; projectId: string };
  filter: string | null;
  onFilter: (key: string | null) => void;
}) {
  const qc = useQueryClient();
  const { data: people = [] } = useQuery({ queryKey: ['people', scope], queryFn: () => api.people(scope) });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const add = useMutation({
    mutationFn: () => api.addProjectContact((scope as { projectId: string }).projectId, { name, email }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['people'] });
      setAdding(false);
      setName('');
      setEmail('');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <aside className="relative flex w-20 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-stone-200 py-3 dark:border-stone-800">
      {people.map((p) => {
        const email = p.emails[0] ?? '';
        const active = filter === p.key;
        return (
          <button
            key={p.key}
            onClick={() => onFilter(active ? null : p.key)}
            title={`${p.name ?? email}${p.name ? ` <${email}>` : ''} · ${p.conversationCount} conversazioni${active ? ' (filtro attivo)' : ''}`}
            className={`rounded-full transition ${filter && !active ? 'opacity-40 hover:opacity-100' : ''}`}
          >
            <Avatar name={p.name} email={email} avatarUrl={p.avatarUrl} size={48} ring={active} />
          </button>
        );
      })}
      {scope.view === 'project' && (
        <button
          className="flex size-12 shrink-0 items-center justify-center rounded-full border border-dashed border-stone-300 text-stone-500 hover:border-stone-500 hover:text-stone-900 dark:border-stone-600 dark:hover:text-stone-100"
          title="Aggiungi una persona al progetto"
          onClick={() => setAdding(!adding)}
        >
          <Icon name="add" />
        </button>
      )}
      {adding && (
        <form onSubmit={submit} className="fixed left-24 z-30 mt-2 w-64 space-y-2 rounded-lg border border-stone-200 bg-white p-3 shadow-lg dark:border-stone-700 dark:bg-stone-900">
          <div className="text-sm font-medium">Aggiungi al progetto</div>
          <input className={input} placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input className={input} placeholder="email@esempio.it" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {add.error && <div className="text-xs text-rose-600">{(add.error as Error).message}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="text-sm text-stone-500" onClick={() => setAdding(false)}>
              Annulla
            </button>
            <button className={primary} disabled={add.isPending}>
              Aggiungi
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}
