import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@mmw/shared';
import { api } from '../api.ts';
const input = 'pm-input';
const button = 'pm-btn pm-btn--secondary pm-btn--sm';
const primary = 'pm-btn pm-btn--primary pm-btn--sm';

/** Creazione o modifica di un progetto. */
export function ProjectDialog({ project, initialName, initialDescription, onClose, onSaved }: {
  project?: ProjectDto;
  /** Valori proposti per un progetto nuovo (es. dal suggerimento dell'analizzatore). */
  initialName?: string;
  initialDescription?: string;
  onClose: () => void;
  onSaved?: (p: ProjectDto) => void;
}) {
  const qc = useQueryClient();
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [name, setName] = useState(project?.name ?? initialName ?? '');
  const [description, setDescription] = useState(project?.description ?? initialDescription ?? '');
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
    <div className="pm-modal" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="pm-modal__card"
      >
        <h2 className="pm-modal__title">{project ? 'Modifica progetto' : 'Nuovo progetto'}</h2>
        <label className="pm-field">
          <span>Nome</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <label className="pm-field">
          <span>Descrizione</span>
          <textarea
            className={input} rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Di cosa si occupa: aiuterà l'analizzatore a smistare la posta"
          />
        </label>
        <label className="pm-field">
          <span>Account di uscita</span>
          <select className={input} value={effectiveAccount} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.email}
              </option>
            ))}
          </select>
          <span className="pm-row__sub">Tutte le email del progetto partono da questo account.</span>
        </label>
        {(save.error || archive.error) && (
          <div className="pm-error">{((save.error || archive.error) as Error).message}</div>
        )}
        <div className="pm-inlineform__actions">
          {project && (
            <button type="button" className={button} onClick={() => archive.mutate()} disabled={archive.isPending}>
              {project.archived ? 'Riattiva' : 'Archivia progetto'}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className={button} onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className={primary} disabled={save.isPending || !effectiveAccount}>
            Salva
          </button>
        </div>
        {accounts.length === 0 && <p className="pm-error">Configura prima un account nelle Impostazioni.</p>}
      </form>
    </div>
  );
}
