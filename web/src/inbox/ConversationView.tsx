import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageDto } from '@mmw/shared';
import { api } from '../api.ts';
import { colorFor, fileSize, initials, longDate, personLabel, shortDate } from '../lib/format.ts';

export function ConversationView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['conversation', id], queryFn: () => api.conversation(id), retry: false });

  // Conversazione sparita (unita a un'altra, o elenco non aggiornato): si riallinea l'elenco.
  useEffect(() => {
    if (error) qc.invalidateQueries({ queryKey: ['conversations'] });
  }, [error, qc]);
  const noise = useMutation({
    mutationFn: (isNoise: boolean) => api.setNoise(id, isNoise),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
      qc.invalidateQueries({ queryKey: ['conversation', id] });
    },
  });

  if (isLoading) return <div className="p-6 text-sm text-stone-500">Caricamento…</div>;
  if (error || !data) return <div className="p-6 text-sm text-rose-600">{(error as Error)?.message ?? 'Non trovata'}</div>;

  const lastId = data.messages[data.messages.length - 1]?.id;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-4 border-b border-stone-200 px-6 py-3 dark:border-stone-800">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug">{data.subject || '(nessun oggetto)'}</h2>
          <p className="text-xs text-stone-500">
            {data.messages.length} {data.messages.length === 1 ? 'messaggio' : 'messaggi'}
          </p>
        </div>
        <button
          className="shrink-0 rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800"
          disabled={noise.isPending}
          onClick={() => noise.mutate(!data.isNoise)}
        >
          {data.isNoise ? 'Non è rumore' : 'Segna come rumore'}
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-stone-100/60 p-4 dark:bg-stone-950">
        {data.messages.map((m) => (
          <MessageCard key={m.id} m={m} defaultOpen={m.id === lastId || !m.seen} />
        ))}
      </div>
    </div>
  );
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
            {m.direction === 'out' && (
              <span className="rounded bg-stone-200 px-1 text-[10px] uppercase text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                inviato
              </span>
            )}
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
