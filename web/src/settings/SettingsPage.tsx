import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useConfirm } from '../ui/confirm.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDto, ConnectionTestResult, MailProvider } from '@mmw/shared';
import { api } from '../api.ts';

export function SettingsPage() {
  return (
    <div className="pm-contacts">
      <header className="pm-contacts__head pm-settings">
        <h1>Impostazioni</h1>
        <p>Account di posta, servizi locali e funzionamento della coda.</p>
      </header>
      <div className="pm-settings">
      <SystemStatus />
      <Accounts />
      <AiModel />
      <General />
      </div>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="pm-panel">
      <div className="pm-panel__head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="pm-settings__body">{children}</div>
    </section>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`pm-dot${ok ? '' : ' pm-dot--off'}`} />;
}

const card = 'pm-settings__card';
const input = 'pm-input';
const button = 'pm-btn pm-btn--secondary pm-btn--sm';
const primary = 'pm-btn pm-btn--primary pm-btn--sm';

// ─── Stato del sistema ───────────────────────────────────────────────────────

function SystemStatus() {
  const { data, error, isLoading } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15000 });
  return (
    <Section title="Stato del sistema">
      <div className={card}>
        {isLoading && <div className="pm-muted">Controllo…</div>}
        {error && (
          <div className="pm-settings__line">
            <Dot ok={false} /> Backend non raggiungibile: {(error as Error).message}
          </div>
        )}
        {data && (
          <>
            <div className="pm-settings__line">
              <Dot ok={data.db.ok} /> Database SQLite {data.db.vec && <span className="pm-muted">· sqlite-vec {data.db.vec}</span>}
            </div>
            <div className="pm-settings__line">
              <Dot ok={data.ollama.ok} /> Ollama <span className="pm-muted">{data.ollama.url}</span>
              {data.ollama.error && <span className="pm-error">{data.ollama.error}</span>}
            </div>
            <div className="pm-settings__line pm-settings__line--sub">
              <Dot ok={data.config.llmAvailable} /> LLM <code>{data.config.llmModel}</code>
              {!data.config.llmAvailable && data.ollama.ok && (
                <span className="pm-muted">
                  non installato — <code>ollama pull {data.config.llmModel}</code>
                </span>
              )}
            </div>
            <div className="pm-settings__line pm-settings__line--sub">
              <Dot ok={data.config.embedAvailable} /> Embedding <code>{data.config.embedModel}</code>
              {!data.config.embedAvailable && data.ollama.ok && (
                <span className="pm-muted">
                  non installato — <code>ollama pull {data.config.embedModel}</code>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

// ─── Account ─────────────────────────────────────────────────────────────────

function Accounts() {
  const qc = useQueryClient();
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="Account"
      action={
        !adding && (
          <button className={button} onClick={() => setAdding(true)}>
            Aggiungi account
          </button>
        )
      }
    >
      {adding && (
        <AccountForm
          onDone={() => {
            setAdding(false);
            qc.invalidateQueries({ queryKey: ['accounts'] });
          }}
        />
      )}
      {accounts.length === 0 && !adding && <div className={`${card} pm-muted`}>Nessun account configurato.</div>}
      {accounts.map((a) => (
        <AccountCard key={a.id} account={a} />
      ))}
    </Section>
  );
}

function AccountCard({ account }: { account: AccountDto }) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const test = useMutation({ mutationFn: () => api.testAccount(account.id) });
  const remove = useMutation({
    mutationFn: () => api.deleteAccount(account.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  return (
    <div className={card}>
      <div className="pm-settings__acct">
        <div>
          <div className="pm-row__name">{account.name}</div>
          <div className="pm-row__sub">
            {account.email} · {account.provider === 'gmail' ? 'Gmail' : 'IMAP'} · {account.imapHost} · credenziale{' '}
            <code>{account.credentialRef}</code>
          </div>
        </div>
        <div className="pm-settings__actions">
          <button className={button} disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Connessione…' : 'Testa connessione'}
          </button>
          <button
            className={button}
            disabled={remove.isPending}
            onClick={async () => (await ask({ message: `Rimuovere l'account ${account.email}?`, okLabel: 'Rimuovi', danger: true })) && remove.mutate()}
          >
            Rimuovi
          </button>
        </div>
      </div>
      {test.error && <div className="pm-error">{(test.error as Error).message}</div>}
      {test.data && <TestResult result={test.data} />}
    </div>
  );
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  if (!result.ok) return <div className="pm-error">✗ {result.error}</div>;
  return (
    <div className="pm-settings__test">
      <div className="pm-ok">
        ✓ Connesso · cartella di sync: <code>{result.syncMailbox}</code>
      </div>
      <table className="pm-table">
        <thead className="pm-muted">
          <tr>
            <th>Cartella</th>
            <th>Tipo</th>
            <th className="pm-num">Messaggi</th>
            <th className="pm-num">Non letti</th>
          </tr>
        </thead>
        <tbody>
          {result.mailboxes?.map((m) => (
            <tr key={m.path}>
              <td>{m.path}</td>
              <td className="pm-muted">{m.specialUse ?? ''}</td>
              <td className="pm-num">{m.messages ?? '–'}</td>
              <td className="pm-num">{m.unseen ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountForm({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState<MailProvider>('gmail');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [credentialRef, setCredentialRef] = useState('env:MMW_TEST_APP_PASSWORD');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const create = useMutation({ mutationFn: api.createAccount, onSuccess: onDone });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      name,
      email,
      provider,
      credentialRef,
      ...(provider === 'imap' ? { imapHost, smtpHost } : {}),
    });
  };

  return (
    <form onSubmit={submit} className={card}>
      <div className="pm-settings__grid">
        <label className="pm-field">
          <span className="pm-muted">Tipo</span>
          <select className={input} value={provider} onChange={(e) => setProvider(e.target.value as MailProvider)}>
            <option value="gmail">Gmail</option>
            <option value="imap">IMAP/SMTP generico</option>
          </select>
        </label>
        <label className="pm-field">
          <span className="pm-muted">Nome (etichetta)</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Prova" required />
        </label>
        <label className="pm-field">
          <span className="pm-muted">Indirizzo email</span>
          <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="pm-field">
          <span className="pm-muted">Credenziale</span>
          <input className={input} value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} required />
        </label>
        {provider === 'imap' && (
          <>
            <label className="pm-field">
              <span className="pm-muted">Server IMAP</span>
              <input className={input} value={imapHost} onChange={(e) => setImapHost(e.target.value)} required />
            </label>
            <label className="pm-field">
              <span className="pm-muted">Server SMTP</span>
              <input className={input} value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} required />
            </label>
          </>
        )}
      </div>
      <p className="pm-row__sub">
        La password non si inserisce qui: si mette in <code>.env.local</code> e qui si indica il nome della variabile
        (es. <code>env:MMW_TEST_APP_PASSWORD</code>). Per Gmail serve una app password.
      </p>
      {create.error && <div className="pm-error">{(create.error as Error).message}</div>}
      <div className="pm-inlineform__actions">
        <button type="button" className={button} onClick={onDone}>
          Annulla
        </button>
        <button type="submit" className={primary} disabled={create.isPending}>
          Salva
        </button>
      </div>
    </form>
  );
}

// ─── Generali ────────────────────────────────────────────────────────────────

function General() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [batch, setBatch] = useState('');
  const [days, setDays] = useState('');
  useEffect(() => {
    if (data) {
      setBatch(String(data.activityBatchMinutes));
      setDays(String(data.initialSyncDays));
    }
  }, [data]);
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (s) => qc.setQueryData(['settings'], s),
  });

  if (!data) return null;
  const dirty = batch !== String(data.activityBatchMinutes) || days !== String(data.initialSyncDays);

  return (
    <Section title="Generali">
      <form
        className={card}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ activityBatchMinutes: Number(batch), initialSyncDays: Number(days) });
        }}
      >
        <div className="pm-settings__grid">
          <label className="pm-field">
            <span className="pm-muted">Esecuzione coda attività ogni (minuti)</span>
            <input className={input} type="number" min={1} value={batch} onChange={(e) => setBatch(e.target.value)} />
          </label>
          <label className="pm-field">
            <span className="pm-muted">Posta recente da importare subito (giorni)</span>
            <input className={input} type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
        </div>
        {save.error && <div className="pm-error">{(save.error as Error).message}</div>}
        <div className="pm-inlineform__actions">
          <button type="submit" className={primary} disabled={!dirty || save.isPending}>
            Salva
          </button>
        </div>
      </form>
    </Section>
  );
}

// ─── Modello di Ollama ───────────────────────────────────────────────────────

function AiModel() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health });
  const save = useMutation({
    mutationFn: (llmModel: string | null) => api.updateSettings({ llmModel }),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      qc.invalidateQueries({ queryKey: ['health'] });
    },
  });
  if (!settings || !health) return null;
  const installed = health.ollama.models.filter((m) => !/embed|bge|nomic|minilm/i.test(m));
  const current = settings.llmModel ?? '';
  const missing = settings.llmModel && !health.ollama.models.some((m) => m === settings.llmModel || m.startsWith(`${settings.llmModel}:`));

  return (
    <Section title="Intelligenza artificiale (Ollama)">
      <div className={card}>
        <div className="pm-settings__grid">
          <label className="pm-field">
            <span className="pm-muted">Modello per assistente, sintesi, task e suggerimenti</span>
            <select className={input} value={current} onChange={(e) => save.mutate(e.target.value || null)} disabled={save.isPending}>
              <option value="">Predefinito ({health.config.defaultLlmModel})</option>
              {installed.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {settings.llmModel && !installed.includes(settings.llmModel) && <option value={settings.llmModel}>{settings.llmModel}</option>}
            </select>
          </label>
          <div className="pm-field">
            <span className="pm-muted">Modello per gli embedding (ricerca per significato)</span>
            <span style={{ padding: '8px 0' }}>
              <code>{health.config.embedModel}</code> <span className="pm-muted">· cambiarlo richiede di reindicizzare la posta</span>
            </span>
          </div>
        </div>
        {!health.ollama.ok && <div className="pm-error">Ollama non è raggiungibile: l'elenco dei modelli installati non è disponibile.</div>}
        {missing && (
          <div className="pm-error">
            Il modello scelto non risulta installato: <code>ollama pull {settings.llmModel}</code>
          </div>
        )}
        <span className="pm-row__sub">
          Si applica subito alle nuove richieste. Modelli più grandi rispondono meglio ma più lentamente; si installano con <code>ollama pull &lt;nome&gt;</code>.
        </span>
        {save.error && <div className="pm-error">{(save.error as Error).message}</div>}
      </div>
    </Section>
  );
}
