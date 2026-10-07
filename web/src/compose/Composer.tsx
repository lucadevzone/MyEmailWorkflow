import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageDto, PersonDto } from '@mmw/shared';
import { api } from '../api.ts';
import { longDate, personLabel } from '../lib/format.ts';
import { button, input, primary } from '../ui/styles.ts';
import { useToast } from '../ui/toast.tsx';
import type { ComposeRequest } from '../workspace/pane.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function replyRecipients(m: MessageDto, all: boolean, own: Set<string>) {
  // Risposta a un messaggio inviato da me: si riscrive agli stessi destinatari.
  const to = m.direction === 'out' ? m.to.map((p) => p.email) : m.from ? [m.from.email] : [];
  const cc = all ? [...m.to, ...m.cc].map((p) => p.email).filter((e) => !own.has(e) && !to.includes(e)) : [];
  return { to, cc: [...new Set(cc)] };
}

function quote(m: MessageDto): string {
  const who = m.from ? personLabel(m.from) : 'qualcuno';
  const body = (m.bodyTextClean || m.bodyText || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\nIl ${longDate(m.date)}, ${who} ha scritto:\n${body}`;
}

/** Nuova email o risposta. Si scrive sempre da un progetto: determina l'account mittente. */
export function Composer({ request, ownEmails, onClose, onSent }: {
  request: ComposeRequest;
  ownEmails: string[];
  onClose: () => void;
  onSent?: (conversationId: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { replyTo, replyAll = false } = request;
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const initial = replyTo ? replyRecipients(replyTo, replyAll, new Set(ownEmails)) : { to: request.to ?? [], cc: [] };

  const [project, setProject] = useState(request.projectId ?? '');
  const [to, setTo] = useState<string[]>(initial.to);
  const [cc, setCc] = useState<string[]>(initial.cc);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState(replyTo ? quote(replyTo) : '');
  const [urgent, setUrgent] = useState(false);

  const recipients = useMemo(() => [...to, ...cc], [to, cc]);
  const { data: suggestions = [] } = useQuery({
    queryKey: ['suggest-project', recipients.join(',')],
    queryFn: () => api.suggestProject(recipients),
    enabled: recipients.length > 0,
  });
  // Senza progetto scelto si propone il più probabile per questi destinatari.
  useEffect(() => {
    if (!project && suggestions[0]) setProject(suggestions[0].projectId);
  }, [project, suggestions]);

  const active = projects.filter((p) => !p.archived);
  const selected = projects.find((p) => p.id === project);
  const from = accounts.find((a) => a.id === selected?.outgoingAccountId);

  const send = useMutation({
    mutationFn: () => api.compose({ projectId: project, replyToMessageId: replyTo?.id, to, cc, bcc, subject, body, urgent }),
    onSuccess: (r) => {
      for (const k of [['conversations'], ['conversation', r.conversationId], ['activities'], ['projects']]) qc.invalidateQueries({ queryKey: k });
      toast({
        text: urgent ? 'Invio in corso…' : 'Messaggio in coda di invio',
        action: urgent ? undefined : { label: 'Annulla', run: () => void api.cancelActivity(r.activityId) },
      });
      onSent?.(r.conversationId);
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };

  return (
    <form onSubmit={submit} className="flex h-full flex-col gap-2 p-6">
      <h2 className="text-lg font-semibold">{replyTo ? `Re: ${replyTo.subject ?? ''}` : 'Nuova email'}</h2>
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2 text-sm">
        <span className="text-stone-500">Progetto</span>
        <div className="space-y-1">
          <select className={input} value={project} onChange={(e) => setProject(e.target.value)} required>
            <option value="" disabled>
              Scegli un progetto…
            </option>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-xs text-stone-500">
              Suggeriti:
              {suggestions.map((s) => (
                <button
                  type="button"
                  key={s.projectId}
                  onClick={() => setProject(s.projectId)}
                  className={`rounded-full px-2 py-0.5 ${s.projectId === project ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' : 'bg-stone-100 hover:bg-stone-200 dark:bg-stone-800'}`}
                  title={`${s.conversations} conversazioni con questi destinatari`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="text-stone-500">Da</span>
        <span className="text-stone-600 dark:text-stone-300">{from ? `${from.name} <${from.email}>` : '—'}</span>
        <span className="text-stone-500">A</span>
        <RecipientInput value={to} onChange={setTo} autoFocus={!replyTo && to.length === 0} />
        <span className="text-stone-500">Cc</span>
        <div className="flex items-start gap-2">
          <RecipientInput value={cc} onChange={setCc} />
          {!showBcc && (
            <button type="button" className="pt-1.5 text-xs text-stone-500 underline" onClick={() => setShowBcc(true)}>
              Ccn
            </button>
          )}
        </div>
        {showBcc && (
          <>
            <span className="text-stone-500">Ccn</span>
            <RecipientInput value={bcc} onChange={setBcc} />
          </>
        )}
        {!replyTo && (
          <>
            <span className="text-stone-500">Oggetto</span>
            <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </>
        )}
      </div>
      <textarea
        className={`${input} min-h-40 flex-1 font-sans leading-relaxed`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoFocus={!!replyTo || to.length > 0}
        onFocus={(e) => replyTo && e.currentTarget.setSelectionRange(0, 0)}
      />
      {replyTo && !request.projectId && <p className="text-xs text-stone-500">Rispondendo, la conversazione verrà spostata nel progetto scelto.</p>}
      {send.error && <div className="text-sm text-rose-600">{(send.error as Error).message}</div>}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
          Urgente (invia subito)
        </label>
        <div className="flex-1" />
        <button type="button" className={button} onClick={onClose}>
          Annulla
        </button>
        <button type="submit" className={primary} disabled={send.isPending || !project}>
          Invia
        </button>
      </div>
    </form>
  );
}

/** Destinatari come etichette, con completamento dai contatti. */
function RecipientInput({ value, onChange, autoFocus }: { value: string[]; onChange: (v: string[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory, staleTime: 60_000 });

  const people: PersonDto[] = useMemo(() => [...(dir?.contacts ?? []), ...(dir?.suggested ?? [])], [dir]);
  const q = text.trim().toLowerCase();
  const matches = q
    ? people
        .flatMap((p) => p.emails.map((email) => ({ name: p.name, email })))
        .filter((p) => !value.includes(p.email) && (p.email.includes(q) || (p.name ?? '').toLowerCase().includes(q)))
        .slice(0, 6)
    : [];

  const add = (email: string) => {
    const e = email.trim().toLowerCase();
    if (e && !value.includes(e)) onChange([...value, e]);
    setText('');
  };
  const commit = () => {
    if (EMAIL.test(text.trim())) add(text);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
      if (matches[0] && !EMAIL.test(text.trim())) {
        e.preventDefault();
        add(matches[0].email);
      } else if (text.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="relative w-full">
      <div className="flex min-h-[34px] w-full flex-wrap items-center gap-1 rounded-md border border-stone-300 px-1.5 py-1 focus-within:ring-2 focus-within:ring-stone-400 dark:border-stone-700">
        {value.map((email) => (
          <span key={email} className="flex items-center gap-1 rounded-full bg-stone-100 py-0.5 pl-2 pr-1 text-xs dark:bg-stone-800">
            {email}
            <button type="button" className="text-stone-400 hover:text-stone-900 dark:hover:text-stone-100" onClick={() => onChange(value.filter((v) => v !== email))} aria-label={`Rimuovi ${email}`}>
              ×
            </button>
          </span>
        ))}
        <input
          className="min-w-32 flex-1 bg-transparent px-1 text-sm outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocus(true)}
          onBlur={() => {
            setFocus(false);
            commit();
          }}
          autoFocus={autoFocus}
        />
      </div>
      {focus && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full rounded-md border border-stone-200 bg-white py-1 text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900">
          {matches.map((m) => (
            <li key={m.email}>
              <button type="button" className="block w-full px-3 py-1 text-left hover:bg-stone-100 dark:hover:bg-stone-800" onMouseDown={(e) => { e.preventDefault(); add(m.email); }}>
                {m.name && <span className="font-medium">{m.name} </span>}
                <span className="text-stone-500">{m.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
