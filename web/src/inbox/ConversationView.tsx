import { useEffect, useRef, useState } from 'react';
import { Composer } from '../compose/Composer.tsx';
import { useToast } from '../ui/toast.tsx';
import { button, ghost } from '../ui/styles.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageDto } from '@mmw/shared';
import { api } from '../api.ts';
import { colorFor, fileSize, initials, longDate, personLabel, shortDate } from '../lib/format.ts';

export function ConversationView({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['conversation', id], queryFn: () => api.conversation(id), retry: false });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const [composer, setComposer] = useState<null | 'reply' | 'replyAll'>(null);
  const readFor = useRef<string | null>(null);

  // Conversazione sparita (unita a un'altra, o elenco non aggiornato): si riallinea l'elenco.
  useEffect(() => {
    if (error) qc.invalidateQueries({ queryKey: ['conversations'] });
  }, [error, qc]);

  // Aprire la conversazione la segna come letta (su Gmail al prossimo batch).
  useEffect(() => {
    if (!data || readFor.current === id) return;
    readFor.current = id;
    if (data.messages.some((m) => !m.seen && m.direction === 'in')) {
      void api.markRead(id).then(() => {
        qc.invalidateQueries({ queryKey: ['conversations'] });
        qc.invalidateQueries({ queryKey: ['counts'] });
        qc.invalidateQueries({ queryKey: ['projects'] });
      });
    }
  }, [data, id, qc]);

  useEffect(() => setComposer(null), [id]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['conversations'] });
    qc.invalidateQueries({ queryKey: ['counts'] });
    qc.invalidateQueries({ queryKey: ['projects'] });
    qc.invalidateQueries({ queryKey: ['conversation', id] });
  };
  const undoActivities = (ids: string[]) => () => void Promise.all(ids.map(api.cancelActivity)).then(refresh);

  const noise = useMutation({ mutationFn: (isNoise: boolean) => api.setNoise(id, isNoise), onSuccess: refresh });
  const move = useMutation({
    mutationFn: (projectId: string | null) => api.move(id, projectId),
    onSuccess: (res, projectId) => {
      refresh();
      const name = projectId ? projects.find((p) => p.id === projectId)?.name : 'Da smistare';
      toast({ text: `Spostata in ${name}`, action: { label: 'Annulla', run: () => void api.move(id, res.previousProjectId).then(refresh) } });
    },
  });
  const archive = useMutation({
    mutationFn: () => (data!.archived ? api.unarchive(id).then(() => ({ activityIds: [] })) : api.archive(id)),
    onSuccess: (res) => {
      refresh();
      if (res.activityIds.length) {
        toast({ text: 'Conversazione archiviata', action: { label: 'Annulla', run: undoActivities(res.activityIds) } });
        onClose();
      }
    },
  });
  const trash = useMutation({
    mutationFn: () => api.trash(id),
    onSuccess: (res) => {
      refresh();
      toast({ text: 'Spostata nel cestino', action: { label: 'Annulla', run: undoActivities(res.activityIds) } });
      onClose();
    },
  });
  const unread = useMutation({
    mutationFn: () => api.markUnread(id),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  if (isLoading) return <div className="p-6 text-sm text-stone-500">Caricamento…</div>;
  if (error || !data) return <div className="p-6 text-sm text-rose-600">{(error as Error)?.message ?? 'Non trovata'}</div>;

  const last = data.messages[data.messages.length - 1];
  const own = accounts.map((a) => a.email.toLowerCase());
  const busy = move.isPending || archive.isPending || trash.isPending || unread.isPending || noise.isPending;

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b border-stone-200 px-6 py-3 dark:border-stone-800">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-snug">{data.subject || '(nessun oggetto)'}</h2>
            <p className="text-xs text-stone-500">
              {data.messages.length} {data.messages.length === 1 ? 'messaggio' : 'messaggi'}
              {data.archived && ' · archiviata'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <select
            className="rounded-md border border-stone-300 bg-transparent px-2 py-1 text-sm dark:border-stone-700"
            value={data.projectId ?? ''}
            disabled={busy}
            onChange={(e) => move.mutate(e.target.value || null)}
            title="Sposta in un progetto"
          >
            <option value="">Da smistare</option>
            {projects
              .filter((p) => !p.archived || p.id === data.projectId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <button className={ghost} disabled={busy} onClick={() => archive.mutate()}>
            {data.archived ? 'Ripristina' : 'Archivia'}
          </button>
          <button className={ghost} disabled={busy} onClick={() => trash.mutate()}>
            Cestina
          </button>
          <button className={ghost} disabled={busy} onClick={() => unread.mutate()}>
            Segna come non letta
          </button>
          {!data.projectId && (
            <button className={ghost} disabled={busy} onClick={() => noise.mutate(!data.isNoise)}>
              {data.isNoise ? 'Non è rumore' : 'È rumore'}
            </button>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-stone-100/60 p-4 dark:bg-stone-950">
        {data.messages.map((m) => (
          <MessageCard key={m.id} m={m} defaultOpen={m.id === last?.id || !m.seen} />
        ))}
        {last &&
          (composer ? (
            <Composer
              key={composer}
              projectId={data.projectId}
              replyTo={last}
              replyAll={composer === 'replyAll'}
              ownEmails={own}
              onClose={() => setComposer(null)}
            />
          ) : (
            <div className="flex gap-2">
              <button className={button} onClick={() => setComposer('reply')}>
                Rispondi
              </button>
              <button className={button} onClick={() => setComposer('replyAll')}>
                Rispondi a tutti
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

function OutgoingBadge({ status }: { status: MessageDto['outgoingStatus'] }) {
  const map = {
    queued: ['in coda', 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'],
    failed: ['invio fallito', 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'],
    sent: ['inviato', 'bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300'],
  } as const;
  const [label, cls] = map[status ?? 'sent'];
  return <span className={`rounded px-1 text-[10px] uppercase ${cls}`}>{label}</span>;
}

function Avatar({ name, email }: { name: string | null; email: string }) {
  return (
    <span
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ background: colorFor(email) }}
    >
      {initials({ name, email })}
    </span>
  );
}

function MessageCard({ m, defaultOpen }: { m: MessageDto; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<'html' | 'text'>(m.hasHtml ? 'html' : 'text');
  const [images, setImages] = useState(false);
  const from = m.from ?? { name: null, email: 'sconosciuto' };
  const files = m.attachments.filter((a) => !a.isInline);

  return (
    <article className="rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <Avatar {...from} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`shrink-0 text-sm ${m.seen ? 'font-medium' : 'font-semibold'}`}>{personLabel(from)}</span>
            <span className="hidden min-w-0 truncate text-xs text-stone-500 xl:inline">&lt;{from.email}&gt;</span>
            {m.direction === 'out' && <OutgoingBadge status={m.outgoingStatus} />}
            <span className="ml-auto shrink-0 text-xs text-stone-500" title={`${from.email} · ${longDate(m.date)}`}>
              {shortDate(m.date)}
            </span>
          </div>
          {open ? (
            <div className="truncate text-xs text-stone-500">
              a {m.to.map(personLabel).join(', ') || '—'}
              {m.cc.length > 0 && <> · cc {m.cc.map(personLabel).join(', ')}</>}
            </div>
          ) : (
            <div className="truncate text-sm text-stone-500">{m.bodyTextClean || m.bodyText}</div>
          )}
        </div>
      </button>

      {open && (
        <div className="space-y-3 px-4 pb-4">
          {m.hasHtml && (
            <div className="flex gap-2 text-xs">
              <button className={mode === 'html' ? 'font-semibold' : 'text-stone-500'} onClick={() => setMode('html')}>
                Originale
              </button>
              <button className={mode === 'text' ? 'font-semibold' : 'text-stone-500'} onClick={() => setMode('text')}>
                Solo testo
              </button>
              {mode === 'html' && !images && (
                <button className="ml-auto text-stone-500 underline" onClick={() => setImages(true)}>
                  Mostra immagini remote
                </button>
              )}
            </div>
          )}
          {mode === 'html' && m.hasHtml ? (
            <HtmlFrame src={`/api/messages/${m.id}/html${images ? '?images=1' : ''}`} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{m.bodyText}</pre>
          )}
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-2 border-t border-stone-100 pt-3 dark:border-stone-800">
              {files.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/api/attachments/${a.id}`}
                    className="flex items-center gap-2 rounded-md border border-stone-200 px-2 py-1 text-xs hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
                  >
                    📎 <span className="max-w-56 truncate">{a.filename ?? 'allegato'}</span>
                    <span className="text-stone-500">{fileSize(a.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * HTML dell'email in un iframe sandbox: niente script (manca allow-scripts),
 * stessa origine solo per misurarne l'altezza; i link si aprono fuori dalla sandbox.
 */
function HtmlFrame({ src }: { src: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const measure = () => setHeight(Math.max(60, doc.documentElement.scrollHeight));
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(doc.documentElement);
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [src]);

  return (
    <iframe
      ref={ref}
      src={src}
      title="Contenuto email"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      className="w-full rounded border-0 bg-white"
      style={{ height }}
    />
  );
}
