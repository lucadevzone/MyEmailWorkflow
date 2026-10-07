import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDto, ConnectionTestResult, MailProvider } from '@mmw/shared';
import { api } from '../api.ts';

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 p-8">
      <h1 className="text-xl font-semibold">Impostazioni</h1>
      <SystemStatus />
      <Accounts />
      <General />
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block size-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />;
}

const card = 'rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900';
const input =
  'w-full rounded-md border border-stone-300 bg-transparent px-2 py-1.5 text-sm dark:border-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-400';
const button =
  'rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800';
const primary = 'rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900';

// ─── Stato del sistema ───────────────────────────────────────────────────────

function SystemStatus() {
  const { data, error, isLoading } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15000 });
  return (
    <Section title="Stato del sistema">
      <div className={`${card} space-y-2 text-sm`}>
        {isLoading && <div className="text-stone-500">Controllo…</div>}
        {error && (
          <div className="flex items-center gap-2">
            <Dot ok={false} /> Backend non raggiungibile: {(error as Error).message}
          </div>
        )}
        {data && (
          <>
            <div className="flex items-center gap-2">
              <Dot ok={data.db.ok} /> Database SQLite {data.db.vec && <span className="text-stone-500">· sqlite-vec {data.db.vec}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Dot ok={data.ollama.ok} /> Ollama <span className="text-stone-500">{data.ollama.url}</span>
              {data.ollama.error && <span className="text-rose-600">{data.ollama.error}</span>}
            </div>
            <div className="flex items-center gap-2 pl-4">
              <Dot ok={data.config.llmAvailable} /> LLM <code>{data.config.llmModel}</code>
              {!data.config.llmAvailable && data.ollama.ok && (
                <span className="text-stone-500">
                  non installato — <code>ollama pull {data.config.llmModel}</code>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 pl-4">
              <Dot ok={data.config.embedAvailable} /> Embedding <code>{data.config.embedModel}</code>
              {!data.config.embedAvailable && data.ollama.ok && (
                <span className="text-stone-500">
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
      {accounts.length === 0 && !adding && <div className={`${card} text-sm text-stone-500`}>Nessun account configurato.</div>}
      {accounts.map((a) => (
        <AccountCard key={a.id} account={a} />
      ))}
    </Section>
  );
}

function AccountCard({ account }: { account: AccountDto }) {
  const qc = useQueryClient();
  const test = useMutation({ mutationFn: () => api.testAccount(account.id) });
  const remove = useMutation({
    mutationFn: () => api.deleteAccount(account.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  return (
    <div className={`${card} space-y-3`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium">{account.name}</div>
          <div className="text-sm text-stone-500">
            {account.email} · {account.provider === 'gmail' ? 'Gmail' : 'IMAP'} · {account.imapHost} · credenziale{' '}
            <code>{account.credentialRef}</code>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button className={button} disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Connessione…' : 'Testa connessione'}
          </button>
          <button
            className={button}
            disabled={remove.isPending}
            onClick={() => confirm(`Rimuovere l'account ${account.email}?`) && remove.mutate()}
          >
            Rimuovi
          </button>
        </div>
      </div>
      {test.error && <div className="text-sm text-rose-600">{(test.error as Error).message}</div>}
      {test.data && <TestResult result={test.data} />}
    </div>
  );
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  if (!result.ok) return <div className="text-sm text-rose-600">✗ {result.error}</div>;
  return (
    <div className="space-y-2 text-sm">
      <div className="text-emerald-600">
        ✓ Connesso · cartella di sync: <code>{result.syncMailbox}</code>
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-stone-500">
          <tr>
            <th className="py-1 font-normal">Cartella</th>
            <th className="font-normal">Tipo</th>
            <th className="text-right font-normal">Messaggi</th>
            <th className="text-right font-normal">Non letti</th>
          </tr>
        </thead>
        <tbody>
          {result.mailboxes?.map((m) => (
            <tr key={m.path} className="border-t border-stone-100 dark:border-stone-800">
              <td className="py-1">{m.path}</td>
              <td className="text-stone-500">{m.specialUse ?? ''}</td>
              <td className="text-right tabular-nums">{m.messages ?? '–'}</td>
              <td className="text-right tabular-nums">{m.unseen ?? '–'}</td>
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
    <form onSubmit={submit} className={`${card} space-y-3`}>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-sm">
          <span className="text-stone-500">Tipo</span>
          <select className={input} value={provider} onChange={(e) => setProvider(e.target.value as MailProvider)}>
            <option value="gmail">Gmail</option>
            <option value="imap">IMAP/SMTP generico</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-stone-500">Nome (etichetta)</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Prova" required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-stone-500">Indirizzo email</span>
          <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-stone-500">Credenziale</span>
          <input className={input} value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} required />
        </label>
        {provider === 'imap' && (
          <>
            <label className="space-y-1 text-sm">
              <span className="text-stone-500">Server IMAP</span>
              <input className={input} value={imapHost} onChange={(e) => setImapHost(e.target.value)} required />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-stone-500">Server SMTP</span>
              <input className={input} value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} required />
            </label>
          </>
        )}
      </div>
      <p className="text-xs text-stone-500">
        La password non si inserisce qui: si mette in <code>.env.local</code> e qui si indica il nome della variabile
        (es. <code>env:MMW_TEST_APP_PASSWORD</code>). Per Gmail serve una app password.
      </p>
      {create.error && <div className="text-sm text-rose-600">{(create.error as Error).message}</div>}
      <div className="flex justify-end gap-2">
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
        className={`${card} space-y-3`}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ activityBatchMinutes: Number(batch), initialSyncDays: Number(days) });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm">
            <span className="text-stone-500">Esecuzione coda attività ogni (minuti)</span>
            <input className={input} type="number" min={1} value={batch} onChange={(e) => setBatch(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-stone-500">Posta recente da importare subito (giorni)</span>
            <input className={input} type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
        </div>
        {save.error && <div className="text-sm text-rose-600">{(save.error as Error).message}</div>}
        <div className="flex justify-end">
          <button type="submit" className={primary} disabled={!dirty || save.isPending}>
            Salva
          </button>
        </div>
      </form>
    </Section>
  );
}
