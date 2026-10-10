import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@mmw/shared';
import { FileText, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { useNavigate } from 'react-router-dom';
import { paths } from '../shell/paths.ts';
import { useConfirm } from '../ui/confirm.tsx';
import { useToast } from '../ui/toast.tsx';
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
        {project && <MergeProject project={project} onDone={onClose} />}
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

/** Fonde questo progetto in un altro: tutto passa al destinatario, questo progetto sparisce. */
function MergeProject({ project, onDone }: { project: ProjectDto; onDone: () => void }) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const others = projects.filter((p) => p.id !== project.id && !p.archived);
  const [intoId, setIntoId] = useState('');
  const merge = useMutation({
    mutationFn: () => api.mergeProject(project.id, intoId),
    onSuccess: (r) => {
      for (const k of [['projects'], ['conversations'], ['counts'], ['tasks'], ['project-resources'], ['project-members']]) qc.invalidateQueries({ queryKey: k });
      const into = others.find((p) => p.id === intoId);
      toast({ text: `${project.name} fuso in ${into?.name ?? 'progetto'}: ${r.movedConversations} conversazioni spostate` });
      navigate(paths.project(intoId));
      onDone();
    },
  });
  if (!others.length) return null;
  const run = async () => {
    const into = others.find((p) => p.id === intoId);
    if (!into) return;
    const ok = await ask({
      message: `Fondere «${project.name}» in «${into.name}»? Conversazioni, task, note, risorse e contatti passano a «${into.name}» e «${project.name}» viene eliminato.`,
      okLabel: 'Fondi',
      danger: true,
    });
    if (ok) merge.mutate();
  };
  return (
    <div className="pm-field">
      <span>Fondi con un altro progetto</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <select className="pm-input" value={intoId} onChange={(e) => setIntoId(e.target.value)} style={{ flex: 1 }} aria-label="Progetto di destinazione">
          <option value="">Scegli il progetto di destinazione…</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" disabled={!intoId || merge.isPending} onClick={() => void run()}>
          Fondi
        </button>
      </div>
      {merge.error && <div className="pm-error">{(merge.error as Error).message}</div>}
    </div>
  );
}
