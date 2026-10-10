import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@mmw/shared';
import { FileText, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { fileSize } from '../lib/format.ts';
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
        {project && <ProjectResources projectId={project.id} />}
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

/** Risorse comuni a tutte le conversazioni del progetto: entrano anche nel contesto dell'assistente. */
function ProjectResources({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ['project-resources', projectId], queryFn: () => api.projectResources(projectId) });
  const common = data.filter((r) => !r.conversationId);
  const refresh = () => {
    for (const k of [['project-resources', projectId], ['project-resources'], ['conversation']]) qc.invalidateQueries({ queryKey: k });
  };
  const add = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await api.uploadProjectResource(projectId, f);
    },
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: api.deleteResource, onSuccess: refresh });
  return (
    <div className="pm-field">
      <span>Risorse del progetto</span>
      <span className="pm-row__sub">File comuni a tutte le conversazioni; i testi aiutano l'assistente.</span>
      {isLoading && <span className="pm-muted">…</span>}
      {common.map((r) => (
        <div key={r.id} className="pm-file">
          <Ic icon={FileText} className="pm-muted" />
          <a href={`/api/resources/${r.id}`} className="pm-file__name pm-truncate" style={{ flex: 1 }}>{r.title}</a>
          {r.size != null && <span className="pm-file__meta">{fileSize(r.size)}</span>}
          <button type="button" className="pm-file__action" title="Elimina" aria-label={`Elimina ${r.title}`} onClick={() => remove.mutate(r.id)}>
            <Ic icon={Trash2} size={15} />
          </button>
        </div>
      ))}
      {!isLoading && common.length === 0 && <span className="pm-muted">Nessuna risorsa comune.</span>}
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (files.length) add.mutate(files);
      }} />
      <button type="button" className="pm-linkbtn" style={{ alignSelf: 'flex-start' }} onClick={() => fileInput.current?.click()} disabled={add.isPending}>
        {add.isPending ? 'Caricamento…' : '+ carica file'}
      </button>
      {(add.error || remove.error) && <div className="pm-error">{((add.error || remove.error) as Error).message}</div>}
    </div>
  );
}
