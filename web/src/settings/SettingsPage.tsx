import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useConfirm } from '../ui/confirm.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMPOSE_FONTS, COMPOSE_FONT_SIZES, type AccountDto, type ComposeFont, type ComposeFontSize, type ConnectionTestResult, type MailProvider, type SenderRuleKind, type SettingsDto, type SignatureDto } from '@mmw/shared';
import { RichEditor } from '../ui/RichEditor.tsx';
import { api } from '../api.ts';
import { useNavigate } from 'react-router-dom';
import { useEscBack } from '../ui/useEscBack.ts';

export function SettingsPage() {
  const navigate = useNavigate();
  useEscBack(() => navigate(-1));
  return (
    <div className="pm-contacts">
      <header className="pm-contacts__head pm-settings">
        <h1>Impostazioni</h1>
        <p>Account di posta, servizi locali e funzionamento della coda.</p>
      </header>
      <div className="pm-settings">
      <SystemStatus />
      <Accounts />
      <AutoSort />
      <SenderRules />
      <Compose />
      <Signatures />
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
          onCancel={() => setAdding(false)}
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
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const setPassword = useMutation({
    mutationFn: (pw: string) => api.setAccountPassword(account.id, pw),
    onSuccess: () => {
      setNewPassword(null);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      test.mutate();
    },
  });
  const inKeychain = account.credentialRef.startsWith('keychain:');
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
            {account.email} · {account.provider === 'gmail' ? 'Gmail' : 'IMAP'} · {account.imapHost} ·{' '}
            {inKeychain ? 'password nel Portachiavi di macOS' : <>password in <code>{account.credentialRef}</code> (variabile d'ambiente)</>}
          </div>
        </div>
        <div className="pm-settings__actions">
          <button className={button} disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Connessione…' : 'Testa connessione'}
          </button>
          <button className={button} onClick={() => setNewPassword(newPassword === null ? '' : null)}>
            Cambia password
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
      {newPassword !== null && (
        <form
          className="pm-settings__password"
          onSubmit={(e) => {
            e.preventDefault();
            if (newPassword) setPassword.mutate(newPassword);
          }}
        >
          <input className={input} type="password" autoComplete="new-password" autoFocus value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)} placeholder={account.provider === 'gmail' ? 'Nuova app password di Google' : 'Nuova password'} aria-label="Nuova password" />
          <button type="submit" className={primary} disabled={!newPassword || setPassword.isPending}>Salva nel Portachiavi</button>
          <button type="button" className={button} onClick={() => setNewPassword(null)}>Annulla</button>
        </form>
      )}
      {setPassword.error && <div className="pm-error">{(setPassword.error as Error).message}</div>}
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

/** Nuovo account; usato anche dalla procedura di benvenuto (senza Annulla). */
export function AccountForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [provider, setProvider] = useState<MailProvider>('gmail');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const create = useMutation({ mutationFn: api.createAccount, onSuccess: onDone });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      name,
      email,
      provider,
      password,
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
          <span className="pm-muted">{provider === 'gmail' ? 'App password di Google' : 'Password'}</span>
          <input className={input} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
        La password viene salvata nel Portachiavi di macOS, mai nel database dell'app. Per Gmail serve una app
        password (Account Google → Sicurezza → Password per le app).
      </p>
      {create.error && <div className="pm-error">{(create.error as Error).message}</div>}
      <div className="pm-inlineform__actions">
        {onCancel && (
          <button type="button" className={button} onClick={onCancel}>
            Annulla
          </button>
        )}
        <button type="submit" className={primary} disabled={create.isPending}>
          {create.isPending ? 'Salvataggio…' : 'Salva'}
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

const RULE_KIND: Record<SenderRuleKind, { label: string; tone: string }> = {
  news: { label: 'News', tone: 'pm-rulekind--news' },
  not_news: { label: 'Non è News', tone: 'pm-rulekind--keep' },
  spam: { label: 'Spam', tone: 'pm-rulekind--spam' },
  not_spam: { label: 'Non è spam', tone: 'pm-rulekind--keep' },
};

/** Regole per mittente create da "è / non è una News", "è / non è Spam": si vedono e si cancellano qui. */
function SenderRules() {
  const qc = useQueryClient();
  const ask = useConfirm();
  const { data: rules = [] } = useQuery({ queryKey: ['sender-rules'], queryFn: api.senderRules });
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<SenderRuleKind | ''>('');
  const remove = useMutation({ mutationFn: api.deleteSenderRule, onSuccess: () => qc.invalidateQueries({ queryKey: ['sender-rules'] }) });
  const shown = rules.filter((r) => (!kind || r.kind === kind) && r.pattern.includes(filter.trim().toLowerCase()));
  return (
    <Section title={`Regole per mittente${rules.length ? ` · ${rules.length}` : ''}`}>
      <div className={card}>
        <span className="pm-row__sub">
          Nascono dalle azioni «È una News», «Non è una News», «È spam», «Non è spam» sulle conversazioni e valgono per la posta futura.
          Eliminare una regola non sposta le conversazioni già smistate.
        </span>
        {rules.length === 0 ? (
          <p className="pm-muted" style={{ margin: '10px 0 0' }}>Nessuna regola per ora.</p>
        ) : (
          <>
            <div className="pm-rules__filters">
              <input className={input} placeholder="Cerca un mittente o un dominio" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Cerca tra le regole" />
              <select className={input} value={kind} onChange={(e) => setKind(e.target.value as SenderRuleKind | '')} aria-label="Tipo di regola">
                <option value="">Tutte</option>
                {Object.entries(RULE_KIND).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <ul className="pm-rules">
              {shown.map((r) => (
                <li key={r.id}>
                  <span className={`pm-rulekind ${RULE_KIND[r.kind].tone}`}>{RULE_KIND[r.kind].label}</span>
                  <span className="pm-truncate" style={{ flex: 1 }}>
                    {r.pattern.startsWith('@') ? <>tutto il dominio <strong>{r.pattern}</strong></> : <strong>{r.pattern}</strong>}
                  </span>
                  <span className="pm-muted">{new Date(r.createdAt).toLocaleDateString('it-IT')}</span>
                  <button
                    type="button"
                    className={button}
                    onClick={async () => (await ask({ message: `Eliminare la regola per ${r.pattern}?`, okLabel: 'Elimina', danger: true })) && remove.mutate(r.id)}
                  >
                    Elimina
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="pm-muted">Nessuna regola corrisponde.</li>}
            </ul>
          </>
        )}
      </div>
    </Section>
  );
}

/** Smistamento della posta nuova (RF-E6): modalità e precisione misurata della regola. */
function AutoSort() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { data: stats } = useQuery({ queryKey: ['auto-sort-stats'], queryFn: api.autoSortStats });
  const save = useMutation({
    mutationFn: (autoSortMode: SettingsDto['autoSortMode']) => api.updateSettings({ autoSortMode }),
    onSuccess: (s) => qc.setQueryData(['settings'], s),
  });
  if (!settings) return null;
  const pct = stats && stats.total ? Math.round((stats.agree / stats.total) * 100) : null;
  return (
    <Section title="Smistamento della posta">
      <div className={card}>
        <label className="pm-field">
          <span className="pm-muted">Conversazioni nuove in Da smistare</span>
          <select className={input} value={settings.autoSortMode} onChange={(e) => save.mutate(e.target.value as SettingsDto['autoSortMode'])} disabled={save.isPending}>
            <option value="off">Spento: nessun suggerimento di progetto</option>
            <option value="suggest">Solo suggerimenti</option>
            <option value="auto">Automatico quando la regola si è dimostrata affidabile</option>
          </select>
        </label>
        <div className="pm-settings__autosort">
          {stats && stats.total === 0 && (
            <span>La regola è in osservazione: non ha ancora visto come smisti tu una conversazione per cui avrebbe deciso.</span>
          )}
          {stats && stats.total > 0 && (
            <span>
              La regola ha deciso <strong>{stats.total}</strong> {stats.total === 1 ? 'volta' : 'volte'}: <strong>{stats.agree}</strong> come te ({pct}%).{' '}
              {stats.reliable ? 'È affidabile.' : `Servono almeno 10 casi con il 90% di decisioni giuste.`}
            </span>
          )}
          {stats && stats.pending > 0 && <span className="pm-muted"> {stats.pending} in attesa di un tuo gesto.</span>}
          {settings.autoSortMode === 'auto' && stats && (
            <span className={stats.reliable ? 'pm-ok' : 'pm-muted'}>
              {stats.reliable ? `Lo smistamento automatico è attivo (${stats.autoMoves} spostamenti finora).` : 'Lo smistamento automatico partirà da solo quando la regola sarà affidabile.'}
            </span>
          )}
        </div>
        <span className="pm-row__sub">
          La regola sposta una conversazione nuova solo se almeno due segnali su tre (persone, contenuto simile, analizzatore) indicano lo stesso
          progetto, il progetto ha almeno 5 conversazioni e non l'hai mai rifiutato per quel mittente. Ogni spostamento si può annullare.
        </span>
      </div>
    </Section>
  );
}

/** Impostazioni generali di composizione: formato, carattere, citazione. Le firme stanno negli account. */
function Compose() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const save = useMutation({
    mutationFn: (patch: Partial<SettingsDto>) => api.updateSettings(patch),
    onSuccess: (s) => qc.setQueryData(['settings'], s),
  });
  if (!settings) return null;
  const html = settings.composeFormat === 'html';
  return (
    <Section title="Composizione">
      <div className={card}>
        <div className="pm-settings__grid">
          <label className="pm-field">
            <span className="pm-muted">Formato delle mail nuove</span>
            <select className={input} value={settings.composeFormat} onChange={(e) => save.mutate({ composeFormat: e.target.value as 'text' | 'html' })}>
              <option value="html">Formattato (HTML)</option>
              <option value="text">Testo semplice</option>
            </select>
          </label>
          <label className="pm-field">
            <span className="pm-muted">Carattere</span>
            <select className={input} value={settings.composeFont} disabled={!html} onChange={(e) => save.mutate({ composeFont: e.target.value as ComposeFont })}>
              {Object.entries(COMPOSE_FONTS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label className="pm-field">
            <span className="pm-muted">Dimensione</span>
            <select className={input} value={settings.composeFontSize} disabled={!html} onChange={(e) => save.mutate({ composeFontSize: e.target.value as ComposeFontSize })}>
              {Object.entries(COMPOSE_FONT_SIZES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label className="pm-field pm-field--check">
            <input type="checkbox" checked={settings.replyIncludeQuote} onChange={(e) => save.mutate({ replyIncludeQuote: e.target.checked })} />
            <span>Nelle risposte includi il messaggio originale</span>
          </label>
        </div>
        <p
          className="pm-settings__fontpreview"
          style={html ? { fontFamily: COMPOSE_FONTS[settings.composeFont].css, fontSize: COMPOSE_FONT_SIZES[settings.composeFontSize].css } : undefined}
        >
          {html ? 'Così appariranno le tue mail: «Ciao, ti mando il documento aggiornato.»' : 'Le mail in testo semplice usano il carattere di chi le legge.'}
        </p>
        <span className="pm-row__sub">Ogni bozza può comunque passare da formattato a testo semplice.</span>
        {save.error && <div className="pm-error">{(save.error as Error).message}</div>}
      </div>
    </Section>
  );
}

/** Firme con un nome: ogni progetto ne sceglie una in "Modifica progetto". */
function Signatures() {
  const qc = useQueryClient();
  const ask = useConfirm();
  const { data: list = [] } = useQuery({ queryKey: ['signatures'], queryFn: api.signatures });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  // null = nessun editor aperto, 'new' = nuova firma, altrimenti l'id della firma in modifica.
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['signatures'] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };
  const remove = useMutation({ mutationFn: api.deleteSignature, onSuccess: refresh });
  const font = settings?.composeFormat === 'html' ? COMPOSE_FONTS[settings.composeFont].css : undefined;
  const size = settings?.composeFormat === 'html' ? COMPOSE_FONT_SIZES[settings.composeFontSize].css : undefined;

  return (
    <Section
      title="Firme"
      action={editing !== 'new' && <button className={button} onClick={() => setEditing('new')}>Nuova firma</button>}
    >
      {editing === 'new' && <SignatureForm font={font} size={size} onDone={() => { setEditing(null); refresh(); }} />}
      {list.length === 0 && editing !== 'new' && (
        <div className={`${card} pm-muted`}>Nessuna firma. Creane una e sceglila nei progetti (Modifica progetto → Firma).</div>
      )}
      {list.map((sig) => {
        const used = projects.filter((p) => p.signatureId === sig.id).map((p) => p.name);
        return editing === sig.id ? (
          <SignatureForm key={sig.id} signature={sig} font={font} size={size} onDone={() => { setEditing(null); refresh(); }} />
        ) : (
          <div key={sig.id} className={card}>
            <div className="pm-settings__acct">
              <div style={{ minWidth: 0 }}>
                <div className="pm-row__name">{sig.label}</div>
                <div className="pm-row__sub pm-truncate">{sig.text.split('\n').join(' · ')}</div>
                <div className="pm-row__sub">{used.length ? `Usata da: ${used.join(', ')}` : 'Non usata da nessun progetto'}</div>
              </div>
              <div className="pm-settings__actions">
                <button className={button} onClick={() => setEditing(sig.id)}>Modifica</button>
                <button
                  className={button}
                  onClick={async () =>
                    (await ask({ message: used.length ? `Eliminare la firma «${sig.label}»? ${used.join(', ')} resteranno senza firma.` : `Eliminare la firma «${sig.label}»?`, okLabel: 'Elimina', danger: true })) &&
                    remove.mutate(sig.id)
                  }
                >
                  Elimina
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

function SignatureForm({ signature, font, size, onDone }: { signature?: SignatureDto; font?: string; size?: string; onDone: () => void }) {
  const [label, setLabel] = useState(signature?.label ?? '');
  const [body, setBody] = useState<{ html: string; text: string }>({ html: signature?.html ?? '', text: signature?.text ?? '' });
  const save = useMutation({
    mutationFn: () => (signature ? api.updateSignature(signature.id, { label, ...body }) : api.createSignature({ label, ...body })),
    onSuccess: onDone,
  });
  return (
    <div className={`${card} pm-settings__signature`}>
      <label className="pm-field">
        <span className="pm-muted">Nome della firma</span>
        <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Es. Lavoro, Personale" autoFocus={!signature} />
      </label>
      <RichEditor boxed label="Testo della firma" minHeight={80} initialHtml={signature?.html ?? ''} onChange={(html, text) => setBody({ html, text })} font={font} size={size} autoFocus={signature ? 'end' : false} />
      <div className="pm-inlineform__actions">
        <button type="button" className={button} onClick={onDone}>Annulla</button>
        <button type="button" className={primary} disabled={!label.trim() || !body.text.trim() || save.isPending} onClick={() => save.mutate()}>
          Salva firma
        </button>
      </div>
      {save.error && <div className="pm-error">{(save.error as Error).message}</div>}
    </div>
  );
}

function AiModel() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health });
  const save = useMutation({
    mutationFn: (patch: Partial<SettingsDto>) => api.updateSettings(patch),
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
            <select className={input} value={current} onChange={(e) => save.mutate({ llmModel: e.target.value || null })} disabled={save.isPending}>
              <option value="">Predefinito ({health.config.defaultLlmModel})</option>
              {installed.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {settings.llmModel && !installed.includes(settings.llmModel) && <option value={settings.llmModel}>{settings.llmModel}</option>}
            </select>
          </label>
          <label className="pm-field pm-field--check">
            <input type="checkbox" checked={settings.aiPaused} onChange={(e) => save.mutate({ aiPaused: e.target.checked })} />
            <span>Metti in pausa l'analisi in background (sintesi, classificazione, indicizzazione); l'assistente resta attivo</span>
          </label>
          <label className="pm-field">
            <span className="pm-muted">Tieni il modello in memoria dopo l'ultimo uso</span>
            <select
              className={input}
              value={settings.ollamaKeepAliveMinutes}
              onChange={(e) => save.mutate({ ollamaKeepAliveMinutes: Number(e.target.value) })}
              disabled={save.isPending}
            >
              {[5, 15, 30, 60, 120, 240].map((m) => (
                <option key={m} value={m}>{m < 60 ? `${m} minuti` : `${m / 60} ${m === 60 ? 'ora' : 'ore'}`}</option>
              ))}
              <option value={-1}>Sempre (finché Ollama è attivo)</option>
            </select>
            <span className="pm-row__sub">Più a lungo = risposte subito pronte dopo una pausa, ma memoria occupata.</span>
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
