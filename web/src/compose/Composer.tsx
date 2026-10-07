import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageDto } from '@mmw/shared';
import { api } from '../api.ts';
import { longDate, personLabel } from '../lib/format.ts';
import { button, input, primary } from '../ui/styles.ts';
import { useToast } from '../ui/toast.tsx';

export interface ComposerProps {
  /** Progetto proposto (quello della conversazione o della vista corrente). */
  projectId: string | null;
  /** Risposta: messaggio a cui si risponde. */
  replyTo?: MessageDto;
  replyAll?: boolean;
  ownEmails: string[];
  onClose: () => void;
  onSent?: (conversationId: string) => void;
}

const split = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function replyRecipients(m: MessageDto, all: boolean, own: Set<string>) {
  // Risposta a un messaggio inviato da me: si riscrive agli stessi destinatari.
  const primaryTo = m.direction === 'out' ? m.to.map((p) => p.email) : m.from ? [m.from.email] : [];
  const cc = all ? [...m.to, ...m.cc].map((p) => p.email).filter((e) => !own.has(e) && !primaryTo.includes(e)) : [];
  return { to: primaryTo, cc: [...new Set(cc)] };
}

function quote(m: MessageDto): string {
  const who = m.from ? personLabel(m.from) : 'qualcuno';
  const body = (m.bodyTextClean || m.bodyText || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\nIl ${longDate(m.date)}, ${who} ha scritto:\n${body}`;
}

/** Nuova email o risposta. Si scrive sempre da un progetto: determina l'account mittente. */
export function Composer({ projectId, replyTo, replyAll = false, ownEmails, onClose, onSent }: ComposerProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const initial = replyTo ? replyRecipients(replyTo, replyAll, new Set(ownEmails)) : { to: [], cc: [] };

  const [project, setProject] = useState(projectId ?? '');
  const [to, setTo] = useState(initial.to.join(', '));
  const [cc, setCc] = useState(initial.cc.join(', '));
  const [bcc, setBcc] = useState('');
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState(replyTo ? quote(replyTo) : '');
  const [urgent, setUrgent] = useState(false);

  const active = projects.filter((p) => !p.archived);
  const selected = projects.find((p) => p.id === project);
  const from = accounts.find((a) => a.id === selected?.outgoingAccountId);

  const send = useMutation({
    mutationFn: () =>
      api.compose({
        projectId: project,
        replyToMessageId: replyTo?.id,
        to: split(to),
        cc: split(cc),
        bcc: split(bcc),
        subject,
        body,
        urgent,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversation', r.conversationId] });
      qc.invalidateQueries({ queryKey: ['activities'] });
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
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-stone-300 bg-white p-4 shadow-sm dark:border-stone-700 dark:bg-stone-900">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-2 text-sm">
        <span className="text-stone-500">Progetto</span>
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
        <span className="text-stone-500">Da</span>
        <span className="text-stone-600 dark:text-stone-300">{from ? `${from.name} <${from.email}>` : '—'}</span>
        <span className="text-stone-500">A</span>
        <input className={input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="indirizzi separati da virgola" />
        <span className="text-stone-500">Cc</span>
        <div className="flex gap-2">
          <input className={input} value={cc} onChange={(e) => setCc(e.target.value)} />
          {!showBcc && (
            <button type="button" className="text-xs text-stone-500 underline" onClick={() => setShowBcc(true)}>
              Ccn
            </button>
          )}
        </div>
        {showBcc && (
          <>
            <span className="text-stone-500">Ccn</span>
            <input className={input} value={bcc} onChange={(e) => setBcc(e.target.value)} />
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
        className={`${input} min-h-48 font-sans leading-relaxed`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoFocus
        onFocus={(e) => replyTo && e.currentTarget.setSelectionRange(0, 0)}
      />
      {replyTo && !projectId && (
        <p className="text-xs text-stone-500">Rispondendo, la conversazione verrà spostata nel progetto scelto.</p>
      )}
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
