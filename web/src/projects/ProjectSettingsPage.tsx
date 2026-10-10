import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useEscBack } from '../ui/useEscBack.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@mmw/shared';
import { ArrowLeft, FileText, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { paths, SYSTEM_INBOX } from '../shell/paths.ts';
import { useConfirm } from '../ui/confirm.tsx';
import { useToast } from '../ui/toast.tsx';
import { Ic } from '../ui/Ic.tsx';
import { fileSize } from '../lib/format.ts';
const input = 'pm-input';
const button = 'pm-btn pm-btn--secondary pm-btn--sm';
const primary = 'pm-btn pm-btn--primary pm-btn--sm';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pm-panel">
      <div className="pm-panel__head">
        <h2>{title}</h2>
      </div>
      <div className="pm-settings__body">{children}</div>
    </section>
  );
}

/**
 * Impostazioni di un progetto (o creazione di un progetto nuovo) come pagina, non come finestra:
 * su schermi bassi si scorre e i pulsanti restano raggiungibili. Esc torna indietro.
 * Progetto nuovo: ?name=…&description=… precompilano; ?suggestion=…&conversation=… (dal suggerimento
 * "Nuovo progetto" dell'analizzatore) spostano subito la conversazione nel progetto creato.
 */
export function ProjectSettingsPage({ projectId }: { projectId: string | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: projects, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projectId ? projects?.find((p) => p.id === projectId) : undefined;
  const back = () => navigate(project ? paths.project(project.id) : -1 as never);

  useEscBack(back);

  if (projectId && !project) {
    return <div className="pm-contacts"><div className="pm-empty">{isLoading ? 'Caricamento…' : 'Progetto non trovato.'}</div></div>;
  }

  return (
    <div className="pm-contacts">
      <header className="pm-contacts__head pm-settings">
        <button type="button" className="pm-btn pm-btn--ghost pm-btn--sm" onClick={back} style={{ alignSelf: 'flex-start', marginBottom: 8 }}>
          <Ic icon={ArrowLeft} size={15} /> {project ? `Torna a ${project.name}` : 'Indietro'}
        </button>
        <h1>{project ? `Impostazioni di ${project.name}` : 'Nuovo progetto'}</h1>
        <p>{project ? 'Nome, account di uscita, firma, risorse comuni e fusione con altri progetti.' : 'Un progetto raccoglie conversazioni, task, note e risorse.'}</p>
      </header>
      <div className="pm-settings">
        <GeneralForm
          key={project?.id ?? 'new'}
          project={project}
          initialName={params.get('name') ?? ''}
          initialDescription={params.get('description') ?? ''}
          onSaved={async (p) => {
            qc.invalidateQueries({ queryKey: ['projects'] });
            const suggestion = params.get('suggestion');
            const conversation = params.get('conversation');
            if (!project && suggestion) {
              await api.acceptSuggestion(suggestion, p.id).catch(() => {});
              for (const k of [['conversations'], ['counts']]) qc.invalidateQueries({ queryKey: k });
            }
            navigate(conversation ? paths.conversation(p.id, conversation) : paths.project(p.id));
          }}
          onCancel={back}
        />
        {project && (
          <Section title="Risorse del progetto">
            <ProjectResources projectId={project.id} />
          </Section>
        )}
        {project && (
          <Section title="Fondi con un altro progetto">
            <MergeProject project={project} onDone={() => {}} />
          </Section>
        )}
        {project && <ArchiveSection project={project} />}
      </div>
    </div>
  );
}

function GeneralForm({ project, initialName, initialDescription, onSaved, onCancel }: {
  project?: ProjectDto;
  initialName: string;
  initialDescription: string;
  onSaved: (p: ProjectDto) => void;
  onCancel: () => void;
}) {
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const { data: signatures = [] } = useQuery({ queryKey: ['signatures'], queryFn: api.signatures });
  const [name, setName] = useState(project?.name ?? initialName);
  const [description, setDescription] = useState(project?.description ?? initialDescription);
  const [accountId, setAccountId] = useState(project?.outgoingAccountId ?? '');
  const [signatureId, setSignatureId] = useState(project?.signatureId ?? '');
  const effectiveAccount = accountId || accounts[0]?.id || '';
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null, outgoingAccountId: effectiveAccount, signatureId: signatureId || null };
      return project ? api.updateProject(project.id, body) : api.createProject(body);
    },
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Section title="Generale">
      <form onSubmit={submit} className="pm-settings__card pm-projectform">
        <label className="pm-field">
          <span>Nome</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!project} required />
        </label>
        <label className="pm-field">
          <span>Descrizione</span>
          <textarea className={input} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Di cosa si occupa: aiuterà l'analizzatore a smistare la posta" />
        </label>
        <label className="pm-field">
          <span>Account di uscita</span>
          <select className={input} value={effectiveAccount} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} — {a.email}</option>
            ))}
          </select>
          <span className="pm-row__sub">Tutte le email del progetto partono da questo account.</span>
        </label>
        <label className="pm-field">
          <span>Firma</span>
          <select className={input} value={signatureId} onChange={(e) => setSignatureId(e.target.value)}>
            <option value="">Nessuna firma</option>
            {signatures.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <span className="pm-row__sub">{signatures.length ? 'Compare in fondo alle mail nuove del progetto. ' : ''}Le firme si creano in Impostazioni → Firme.</span>
        </label>
        {save.error && <div className="pm-error">{(save.error as Error).message}</div>}
        {accounts.length === 0 && <p className="pm-error">Configura prima un account nelle Impostazioni.</p>}
        <div className="pm-inlineform__actions">
          <span style={{ flex: 1 }} />
          <button type="button" className={button} onClick={onCancel}>Annulla</button>
          <button type="submit" className={primary} disabled={save.isPending || !effectiveAccount || !name.trim()}>
            {project ? 'Salva' : 'Crea progetto'}
          </button>
        </div>
      </form>
    </Section>
  );
}

function ArchiveSection({ project }: { project: ProjectDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ask = useConfirm();
  const archive = useMutation({
    mutationFn: () => api.updateProject(project.id, { archived: !project.archived }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      if (!project.archived) navigate(paths.project(SYSTEM_INBOX));
    },
  });
  return (
    <Section title={project.archived ? 'Progetto archiviato' : 'Archivia'}>
      <div className="pm-settings__card pm-settings__acct">
        <span className="pm-row__sub">
          {project.archived ? 'Il progetto è archiviato: non compare nella barra dei progetti.' : 'Un progetto archiviato sparisce dalla barra dei progetti; conversazioni, task e note restano.'}
        </span>
        <button
          type="button"
          className={button}
          disabled={archive.isPending}
          onClick={async () => (project.archived || (await ask({ message: `Archiviare «${project.name}»?`, okLabel: 'Archivia' }))) && archive.mutate()}
        >
          {project.archived ? 'Riattiva' : 'Archivia progetto'}
        </button>
      </div>
      {archive.error && <div className="pm-error">{(archive.error as Error).message}</div>}
    </Section>
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
    <div className="pm-field pm-settings__card">
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
    <div className="pm-field pm-settings__card">
      <span className="pm-row__sub">Conversazioni, task, note, risorse e contatti passano al progetto scelto; questo progetto viene eliminato.</span>
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
