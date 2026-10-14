// Procedura di benvenuto: si apre da sola quando non c'è ancora nessun account. Quattro passi:
// cos'è l'app, un account di posta, i primi progetti (così lo smistamento parte già "intelligente"), fatto.
// Riusa il modulo dell'account delle impostazioni e la creazione dei progetti: niente di nuovo sul server.
// Ramo «Ho già l'app su un altro PC» (docs/03-uso-su-piu-pc.md §8): cartella condivisa, presa dei dati
// personali consegnati dall'altro PC, password degli account (nel Portachiavi di questo Mac), posta da Gmail.

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, FolderPlus, Inbox, KeyRound, Laptop, Mail, Sparkles } from 'lucide-react';
import type { SyncStatusDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { AccountForm } from '../settings/SettingsPage.tsx';
import { paths, SYSTEM_INBOX } from '../shell/paths.ts';
import { useSharingStatus } from '../shell/Sharing.tsx';
import { useToast } from '../ui/toast.tsx';

const STEPS = ['Benvenuto', 'Account', 'Progetti', 'Pronto'] as const;
const JOIN_STEPS = ['Benvenuto', 'Cartella condivisa', 'Password', 'Pronto'] as const;

export function WelcomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const join = params.get('mode') === 'join';
  const steps = join ? JOIN_STEPS : STEPS;
  const step = Math.min(steps.length - 1, Math.max(0, Number(params.get('step') ?? 0)));
  const go = (n: number, asJoin = join) => setParams(n ? { step: String(n), ...(asJoin ? { mode: 'join' } : {}) } : {});
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const active = projects.filter((p) => !p.archived);

  const finish = () => navigate(paths.project(SYSTEM_INBOX));

  return (
    <div className="pm-welcome">
      <ol className="pm-welcome__steps" aria-label="Passi">
        {steps.map((label, i) => (
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
              <button type="button" className="pm-btn pm-btn--ghost" onClick={() => go(1, true)}>
                <Ic icon={Laptop} size={15} /> Ho già l'app su un altro PC
              </button>
              <button type="button" className="pm-btn pm-btn--primary" onClick={() => go(1, false)}>Iniziamo</button>
            </div>
          </>
        )}

        {join && step === 1 && <JoinFolder onBack={() => go(0)} onNext={() => go(2)} />}
        {join && step === 2 && <JoinPasswords onBack={() => go(1)} onNext={() => go(3)} />}
        {join && step === 3 && (
          <>
            <h1>Tutto pronto</h1>
            <ul className="pm-welcome__points">
              <li><Ic icon={FolderPlus} size={16} /><span>Progetti, task, note e regole sono quelli dell'altro PC.</span></li>
              <li><Ic icon={Inbox} size={16} /><span>La posta arriva da Gmail, prima la più recente: ogni conversazione compare <strong>già nel suo progetto</strong>. Lo storico completo può richiedere qualche ora.</span></li>
              <li><Ic icon={Laptop} size={16} /><span>Un PC alla volta: quando smetti di usare questo, il database passa all'altro da solo dopo qualche minuto (o subito con <strong>Rilascia</strong> nel menu Stato).</span></li>
            </ul>
            <div className="pm-welcome__actions">
              <button type="button" className="pm-btn pm-btn--ghost" onClick={() => go(2)}>Indietro</button>
              <button type="button" className="pm-btn pm-btn--primary" onClick={finish}>Vai alla posta</button>
            </div>
          </>
        )}

        {!join && step === 1 && (
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

        {!join && step === 2 && (
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

        {!join && step === 3 && (
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
    catchup: 'aggiornamento con la posta arrivata nel frattempo…',
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

/** Secondo PC: scelta della cartella condivisa e presa dei dati personali consegnati dall'altro PC. */
function JoinFolder({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: st } = useSharingStatus();
  const { data: suggested = [] } = useQuery({ queryKey: ['sharing-folders'], queryFn: api.sharingSuggestedFolders });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: st?.state === 'holder' });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts, enabled: st?.state === 'holder' });
  const [name, setName] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!st) return null;
  const target = folder ?? st.folder ?? suggested[0] ?? '';
  const connected = st.state !== 'disabled';
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries();
      if (done) toast({ text: done });
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      if (name !== null && name.trim() && name !== st.machineName) await api.sharingMachine({ name: name.trim() });
      await api.sharingFolder({ folder: target, join: true });
    });
  return (
    <>
      <h1>Collega questo PC all'altro</h1>
      <p>
        Scegli la cartella condivisa che usi sull'altro PC (su Google Drive). Da lì arrivano progetti, task, note, regole e contatti: pochi
        MB. La posta invece la scarica questo PC da Gmail.
      </p>
      <div className="pm-welcome__form">
        <label className="pm-field">
          <span className="pm-muted">Nome di questo PC (lo vedrai sull'altro)</span>
          <input className="pm-input" value={name ?? st.machineName} onChange={(e) => setName(e.target.value)} disabled={connected} />
        </label>
        <label className="pm-field">
          <span className="pm-muted">Cartella condivisa</span>
          <input className="pm-input" placeholder="…/Google Drive/Il mio Drive/MyEmailWorkflow" value={target} onChange={(e) => setFolder(e.target.value)} disabled={connected} />
        </label>
        {!connected && suggested.length > 0 && (
          <div className="pm-row__sub">
            Google Drive su questo Mac:{' '}
            {suggested.map((f) => (
              <button key={f} type="button" className="pm-linkbtn" onClick={() => setFolder(f)}>
                {f.replace(/^.*\/CloudStorage\//, '')}
              </button>
            ))}
          </div>
        )}
        {!connected && suggested.length === 0 && (
          <p className="pm-muted">Non trovo Google Drive per desktop su questo Mac: installalo e accedi con lo stesso account dell'altro PC, oppure scrivi il percorso della cartella.</p>
        )}
      </div>

      {connected && (
        <div className="pm-welcome__list">
          {st.error ? (
            <div className="pm-error">{st.error}</div>
          ) : st.state === 'holder' ? (
            <div className="pm-welcome__item">
              <Ic icon={Check} size={16} className="pm-ok" /> Dati arrivati: <strong>{projects.filter((p) => !p.archived).length} progetti</strong>,{' '}
              {accounts.length} account
            </div>
          ) : st.state === 'syncing' ? (
            <div className="pm-welcome__sync">Google Drive sta ancora scaricando i dati dell'altro PC (versione {st.lease?.version ?? '?'})…</div>
          ) : st.lease?.holderName ? (
            <div className="pm-welcome__sync">
              Il database è in uso su <strong>{st.lease.holderName}</strong>
              {st.lease.releaseRequestedBy ? ': richiesta inviata, arriva appena lo consegna.' : '. Chiudi l\'app lì, oppure chiedi qui di passarlo.'}
              {!st.lease.releaseRequestedBy && (
                <button type="button" className="pm-linkbtn" disabled={busy} onClick={() => void run(api.sharingRequestRelease, `Richiesta inviata a ${st.lease?.holderName}`)}>
                  Chiedi il database a {st.lease.holderName}
                </button>
              )}
              {st.holderStale && (
                <button type="button" className="pm-linkbtn" disabled={busy} onClick={() => void run(() => api.sharingAcquire(true))}>
                  {st.lease.holderName} non dà segni: prendi comunque
                </button>
              )}
            </div>
          ) : (
            <div className="pm-welcome__sync">Presa dei dati in corso…</div>
          )}
        </div>
      )}

      <div className="pm-welcome__actions">
        {connected ? (
          <button type="button" className="pm-btn pm-btn--ghost" disabled={busy} onClick={() => void run(() => api.sharingFolder({ folder: null }))}>
            Cambia cartella
          </button>
        ) : (
          <button type="button" className="pm-btn pm-btn--ghost" onClick={onBack}>Indietro</button>
        )}
        {connected ? (
          <button type="button" className="pm-btn pm-btn--primary" disabled={st.state !== 'holder'} onClick={onNext}>Avanti</button>
        ) : (
          <button type="button" className="pm-btn pm-btn--primary" disabled={busy || !target.trim()} onClick={() => void connect()}>Collegati</button>
        )}
      </div>
    </>
  );
}

/** Secondo PC: gli account arrivano dall'altro PC, le password no (stanno nel Portachiavi di ciascun Mac). */
function JoinPasswords({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const { data: creds = [] } = useQuery({ queryKey: ['account-credentials'], queryFn: api.accountCredentials });
  const has = new Map(creds.map((c) => [c.id, c.hasPassword]));
  const missing = accounts.filter((a) => has.get(a.id) === false).length;
  return (
    <>
      <h1>Password degli account</h1>
      <p>
        Le password non viaggiano tra i PC: inseriscile qui una volta. Vengono salvate nel Portachiavi di questo Mac; poi parte l'importazione
        della posta.
      </p>
      <div className="pm-welcome__list">
        {accounts.map((a) => (has.get(a.id) ? (
          <div key={a.id} className="pm-welcome__item">
            <Ic icon={Check} size={16} className="pm-ok" /> <strong>{a.name}</strong> <span className="pm-muted">{a.email}</span>
          </div>
        ) : (
          <PasswordRow key={a.id} id={a.id} name={a.name} email={a.email} gmail={a.provider === 'gmail'} />
        )))}
        {accounts.length > 0 && <SyncProgress />}
      </div>
      <div className="pm-welcome__actions">
        <button type="button" className="pm-btn pm-btn--ghost" onClick={onBack}>Indietro</button>
        <button type="button" className="pm-btn pm-btn--primary" onClick={onNext}>{missing ? 'Più tardi' : 'Avanti'}</button>
      </div>
    </>
  );
}

function PasswordRow({ id, name, email, gmail }: { id: string; name: string; email: string; gmail: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () => api.setAccountPassword(id, password),
    onSuccess: () => {
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['account-credentials'] });
      void qc.invalidateQueries({ queryKey: ['sync'] });
    },
  });
  return (
    <form
      className="pm-welcome__password"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) save.mutate();
      }}
    >
      <Ic icon={KeyRound} size={16} />
      <span className="pm-welcome__who">
        <strong>{name}</strong> <span className="pm-muted">{email}</span>
      </span>
      <input
        className="pm-input"
        type="password"
        autoComplete="new-password"
        placeholder={gmail ? 'App password di Google' : 'Password'}
        aria-label={`Password di ${email}`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="pm-btn pm-btn--secondary pm-btn--sm" disabled={!password || save.isPending}>Salva</button>
      {save.error && <div className="pm-error">{(save.error as Error).message}</div>}
    </form>
  );
}
