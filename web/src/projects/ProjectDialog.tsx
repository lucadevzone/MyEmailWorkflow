import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
import { input, button, primary } from '../ui/styles.ts';

/** Creazione o modifica di un progetto. */
export function ProjectDialog({ project, onClose, onSaved }: { project?: ProjectDto; onClose: () => void; onSaved?: (p: ProjectDto) => void }) {
  const qc = useQueryClient();
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [accountId, setAccountId] = useState(project?.outgoingAccountId ?? '');
  const effectiveAccount = accountId || accounts[0]?.id || '';

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null, outgoingAccountId: effectiveAccount };
      return project ? api.updateProject(project.id, body) : api.createProject(body);
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      onSaved?.(p);
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () => api.updateProject(project!.id, { archived: !project!.archived }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-xl bg-white p-6 shadow-xl dark:bg-stone-900"
      >
        <h2 className="text-lg font-semibold">{project ? 'Modifica progetto' : 'Nuovo progetto'}</h2>
        <label className="block space-y-1 text-sm">
          <span className="text-stone-500">Nome</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-stone-500">Descrizione</span>
          <textarea
            className={`${input} min-h-20`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Di cosa si occupa: aiuterà l'analizzatore a smistare la posta"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-stone-500">Account di uscita</span>
          <select className={input} value={effectiveAccount} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.email}
              </option>
            ))}
          </select>
          <span className="block text-xs text-stone-500">Tutte le email del progetto partono da questo account.</span>
        </label>
        {(save.error || archive.error) && (
          <div className="text-sm text-rose-600">{((save.error || archive.error) as Error).message}</div>
        )}
        <div className="flex items-center gap-2">
          {project && (
            <button type="button" className={button} onClick={() => archive.mutate()} disabled={archive.isPending}>
              {project.archived ? 'Riattiva' : 'Archivia progetto'}
            </button>
          )}
          <div className="flex-1" />
          <button type="button" className={button} onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className={primary} disabled={save.isPending || !effectiveAccount}>
            Salva
          </button>
        </div>
        {accounts.length === 0 && <p className="text-xs text-rose-600">Configura prima un account nelle Impostazioni.</p>}
      </form>
    </div>
  );
}
