import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { fileSize, longDate, personLabel } from '../lib/format.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Icon } from '../ui/Icon.tsx';
import { HtmlFrame } from './HtmlFrame.tsx';
import type { PaneAction } from './pane.ts';

/** Un messaggio nella colonna di destra. Aprirlo lo segna come letto. */
export function MessageView({ conversationId, messageId, pane }: { conversationId: string; messageId: string; pane: PaneAction }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.conversation(conversationId) });
  const [mode, setMode] = useState<'html' | 'text'>('html');
  const [images, setImages] = useState(false);
  const marked = useRef<string | null>(null);
  const m = data?.messages.find((x) => x.id === messageId);

  useEffect(() => {
    setImages(false);
    setMode('html');
  }, [messageId]);

  useEffect(() => {
    if (!m || m.seen || m.direction !== 'in' || marked.current === m.id) return;
    marked.current = m.id;
    void api.markMessageRead(m.id).then(() => {
      for (const k of [['conversation', conversationId], ['conversations'], ['counts'], ['projects']]) qc.invalidateQueries({ queryKey: k });
    });
  }, [m, conversationId, qc]);

  if (!data) return <div className="p-6 text-sm text-stone-500">Caricamento…</div>;
  if (!m) return <div className="p-6 text-sm text-stone-500">Messaggio non trovato.</div>;

  const from = m.from ?? { name: null, email: 'sconosciuto' };
  const files = m.attachments.filter((a) => !a.isInline);
  const showHtml = m.hasHtml && mode === 'html';

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-3 border-b border-stone-200 px-6 py-4 dark:border-stone-800">
        <h2 className="text-lg font-semibold leading-snug">{m.subject || '(nessun oggetto)'}</h2>
        <div className="flex items-start gap-3">
          <Avatar {...from} size={36} />
          <div className="min-w-0 flex-1 text-sm">
            <div>
              <span className="font-medium">{personLabel(from)}</span> <span className="text-stone-500">&lt;{from.email}&gt;</span>
            </div>
            <div className="truncate text-xs text-stone-500">
              a {m.to.map(personLabel).join(', ') || '—'}
              {m.cc.length > 0 && <> · cc {m.cc.map(personLabel).join(', ')}</>}
            </div>
          </div>
          <span className="shrink-0 text-xs text-stone-500">{longDate(m.date)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded bg-stone-900 px-2 py-1 text-xs font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900" onClick={() => pane.compose({ replyTo: m, replyAll: true, projectId: data.projectId })}>
            Rispondi a tutti
          </button>
          <button className="rounded bg-stone-100 px-2 py-1 text-xs font-medium hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700" onClick={() => pane.compose({ replyTo: m, replyAll: false, projectId: data.projectId })}>
            Rispondi solo al mittente
          </button>
          <div className="flex-1" />
          {m.hasHtml && (
            <div className="flex gap-2 text-xs">
              <button className={mode === 'html' ? 'font-semibold' : 'text-stone-500'} onClick={() => setMode('html')}>
                Originale
              </button>
              <button className={mode === 'text' ? 'font-semibold' : 'text-stone-500'} onClick={() => setMode('text')}>
                Solo testo
              </button>
            </div>
          )}
          {showHtml && !images && (
            <button className="text-xs text-stone-500 underline" onClick={() => setImages(true)}>
              Mostra immagini
            </button>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {showHtml ? (
          <HtmlFrame src={`/api/messages/${m.id}/html${images ? '?images=1' : ''}`} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{m.bodyText}</pre>
        )}
        {files.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2 border-t border-stone-200 pt-3 dark:border-stone-800">
            {files.map((a) => (
              <li key={a.id}>
                <a href={`/api/attachments/${a.id}`} className="flex items-center gap-1.5 rounded-md border border-stone-200 px-2 py-1 text-xs hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800">
                  <Icon name="attach_file" size={16} />
                  <span className="max-w-56 truncate">{a.filename ?? 'allegato'}</span>
                  {a.versionCount && a.versionCount > 1 && (
                    <span className="rounded bg-stone-200 px-1 text-[10px] font-medium dark:bg-stone-700" title="Versione del file in questa conversazione">
                      v{a.versionNo} di {a.versionCount}
                    </span>
                  )}
                  <span className="text-stone-500">{fileSize(a.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
