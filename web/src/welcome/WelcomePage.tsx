// Procedura di benvenuto: si apre da sola quando non c'è ancora nessun account. Quattro passi:
// cos'è l'app, un account di posta, i primi progetti (così lo smistamento parte già "intelligente"), fatto.
// Riusa il modulo dell'account delle impostazioni e la creazione dei progetti: niente di nuovo sul server.

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, FolderPlus, Inbox, Mail, Sparkles } from 'lucide-react';
import type { SyncStatusDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { AccountForm } from '../settings/SettingsPage.tsx';
import { paths, SYSTEM_INBOX } from '../shell/paths.ts';

const STEPS = ['Benvenuto', 'Account', 'Progetti', 'Pronto'] as const;

export function WelcomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const step = Math.min(STEPS.length - 1, Math.max(0, Number(params.get('step') ?? 0)));
  const go = (n: number) => setParams(n ? { step: String(n) } : {});
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const active = projects.filter((p) => !p.archived);

  const finish = () => navigate(paths.project(SYSTEM_INBOX));

  return (
    <div className="pm-welcome">
      <ol className="pm-welcome__steps" aria-label="Passi">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
            <span className="pm-welcome__dot">{i < step ? <Ic icon={Check} size={13} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <section className="pm-welcome__card">
        {step === 0 && (
          <>
            <h1>Benvenuto in my mail workflow</h1>
            <p>Un client di posta organizzato per <strong>progetti e persone</strong>, non per cartelle e account.</p>
            <ul className="pm-welcome__points">
              <li><Ic icon={Inbox} size={16} /><span>Tutta la posta nuova arriva in <strong>Da smistare</strong>, da qualsiasi account.</span></li>
              <li><Ic icon={FolderPlus} size={16} /><span>Ogni conversazione sta in un <strong>progetto</strong>, con i suoi task, note e file.</span></li>
              <li><Ic icon={Sparkles} size={16} /><span>Un assistente che gira <strong>solo sul tuo computer</strong> propone dove smistare, riassume e aiuta a rispondere.</span></li>
            </ul>
            <p className="pm-muted">Bastano due passi per iniziare: collegare un account e creare i primi progetti.</p>
            <div className="pm-welcome__actions">
              <span />
              <button type="button" className="pm-btn pm-btn--primary" onClick={() => go(1)}>Iniziamo</button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Collega un account di posta</h1>
            <p>La posta recente viene importata subito, quella più vecchia poco alla volta in background.</p>
            {accounts.length > 0 && (
              <div className="pm-welcome__list">
                {accounts.map((a) => (
                  <div key={a.id} className="pm-welcome__item">
                    <Ic icon={Check} size={16} className="pm-ok" /> <strong>{a.name}</strong> <span className="pm-muted">{a.email}</span>
                  </div>
                ))}
                <SyncProgress />
              </div>
            )}
            {accounts.length === 0 ? <AccountStep /> : <AddAnother />}
            <div className="pm-welcome__actions">
              <button type="button" className="pm-btn pm-btn--ghost" onClick={() => go(0)}>Indietro</button>
              <button type="button" className="pm-btn pm-btn--primary" disabled={!accounts.length} onClick={() => go(2)}>
                Avanti
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Crea i tuoi progetti</h1>
            <p>
              Un progetto per ogni attività che segui (un corso, un cliente, una ricerca…). Con i progetti l'analizzatore può proporre da
              subito dove smistare la posta. <strong>La descrizione lo aiuta molto</strong>: scrivi di cosa si occupa.
            </p>
            {active.length > 0 && (
              <div className="pm-welcome__list">
                {active.map((p) => (
                  <div key={p.id} className="pm-welcome__item">
                    <Ic icon={Check} size={16} className="pm-ok" /> <strong>{p.name}</strong>
                    {p.description && <span className="pm-muted pm-truncate">{p.description}</span>}
                  </div>
                ))}
              </div>
            )}
            <ProjectStep accountId={accounts[0]?.id ?? ''} existing={active.map((p) => p.name.toLowerCase())} />
            <div className="pm-welcome__actions">
              <button type="button" className="pm-btn pm-btn--ghost" onClick={() => go(1)}>Indietro</button>
              <button type="button" className="pm-btn pm-btn--primary" onClick={() => go(3)}>
                {active.length ? 'Avanti' : 'Salta per ora'}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1>Tutto pronto</h1>
            <ul className="pm-welcome__points">
              <li><Ic icon={Inbox} size={16} /><span>In <strong>Da smistare</strong> sotto ogni conversazione trovi il progetto proposto: un clic per spostarla.</span></li>
              <li><Ic icon={Sparkles} size={16} /><span>Quando l'analizzatore avrà imparato come smisti, in Impostazioni puoi attivare lo <strong>smistamento automatico</strong>.</span></li>
              <li><Ic icon={Mail} size={16} /><span>Da un progetto scrivi e rispondi: le mail partono dal suo account.</span></li>
            </ul>
            {!active.length && <p className="pm-muted">Non hai ancora creato progetti: puoi farlo quando vuoi con il + nella barra in alto.</p>}
            <div className="pm-welcome__actions">
              <button type="button" className="pm-btn pm-btn--ghost" onClick={() => go(2)}>Indietro</button>
              <button type="button" className="pm-btn pm-btn--primary" onClick={finish}>Vai alla posta</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function AccountStep() {
  const qc = useQueryClient();
  return <AccountForm onDone={() => void qc.invalidateQueries({ queryKey: ['accounts'] })} />;
}

function AddAnother() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="pm-linkbtn" onClick={() => setOpen(true)}>
        + aggiungi un altro account
      </button>
    );
  }
  return (
    <AccountForm
      onDone={() => {
        setOpen(false);
        void qc.invalidateQueries({ queryKey: ['accounts'] });
      }}
      onCancel={() => setOpen(false)}
    />
  );
}

/** Avanzamento dell'importazione: mentre si creano i progetti la posta continua ad arrivare. */
function SyncProgress() {
  const { data: statuses = [] } = useQuery({ queryKey: ['sync'], queryFn: api.syncStatus, refetchInterval: 3000 });
  const label: Record<SyncStatusDto['phase'], string> = {
    stopped: 'in pausa',
    connecting: 'connessione…',
    initial: 'importazione della posta recente…',
    backfill: 'importazione dello storico in background…',
    idle: 'posta aggiornata',
    error: 'errore di connessione',
  };
  return (
    <>
      {statuses.map((s) => (
        <div key={s.accountId} className={`pm-welcome__sync${s.phase === 'error' ? ' pm-error' : ''}`}>
          {label[s.phase]}
          {s.imported > 0 && ` · ${s.imported} messaggi importati`}
          {s.error && ` · ${s.error}`}
        </div>
      ))}
    </>
  );
}

function ProjectStep({ accountId, existing }: { accountId: string; existing: string[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Proposte dell'analizzatore dalla posta già importata ("Nuovo progetto «…»" in Da smistare).
  const { data: inbox = [] } = useQuery({ queryKey: ['conversations', { view: 'inbox' }], queryFn: () => api.conversations({ view: 'inbox' }), refetchInterval: 10_000 });
  const proposals = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of inbox) {
      for (const s of c.suggestions) {
        if (s.kind !== 'new_project') continue;
        const p = s.payload as { projectName?: string; reason?: string };
        if (p.projectName && !existing.includes(p.projectName.toLowerCase())) seen.set(p.projectName, p.reason ?? '');
      }
    }
    return [...seen.entries()].slice(0, 6);
  }, [inbox, existing]);
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), description: description.trim() || null, outgoingAccountId: accountId }),
    onSuccess: () => {
      setName('');
      setDescription('');
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  return (
    <>
      {proposals.length > 0 && (
        <div className="pm-welcome__proposals">
          <span className="pm-muted">Dalla tua posta l'analizzatore propone:</span>
          {proposals.map(([n, reason]) => (
            <button key={n} type="button" className="pm-quick pm-quick--ai" title={reason} onClick={() => { setName(n); setDescription(reason); }}>
              {n}
            </button>
          ))}
        </div>
      )}
      <form className="pm-welcome__form" onSubmit={submit}>
        <input className="pm-input" placeholder="Nome del progetto (es. Corso di Basi di dati)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome del progetto" />
        <textarea className="pm-input" rows={2} placeholder="Di cosa si occupa: chi scrive, di quali argomenti" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Descrizione del progetto" />
        <button type="submit" className="pm-btn pm-btn--secondary" disabled={!name.trim() || !accountId || create.isPending}>
          <Ic icon={FolderPlus} size={15} /> Aggiungi progetto
        </button>
        {create.error && <div className="pm-error">{(create.error as Error).message}</div>}
      </form>
    </>
  );
}
