import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bookmark, ChevronDown, ChevronUp, Forward, Image, Paperclip, Reply, ReplyAll, SquareCheck, StickyNote } from 'lucide-react';
import type { ConversationDetail, MessageDto } from '@mmw/shared';
import { api } from '../api.ts';
import { fileSize, longDate, shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { PersonAvatar, PersonChip, useDisplayName } from '../ui/People.tsx';
import { useToast } from '../ui/toast.tsx';
import { HtmlFrame } from '../workspace/HtmlFrame.tsx';
import { TagEditor, type TagEditorTarget } from '../project/TagEditor.tsx';
import type { ComposeRequest } from '../workspace/pane.ts';

const UNKNOWN = { name: null, email: 'sconosciuto' };

/** Toggle "Importante" (D16): segnalibro ocra pieno quando attivo. */
export function ImportantToggle({ m, conversationId }: { m: MessageDto; conversationId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await api.setImportant(m.id, !m.important);
      for (const k of [['conversation', conversationId], ['conversations'], ['activities']]) qc.invalidateQueries({ queryKey: k });
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="pm-important"
      aria-pressed={m.important}
      aria-label="Importante"
      title={m.important ? 'Togli importante' : 'Segna come importante'}
      onClick={toggle}
      disabled={busy}
    >
      <Ic icon={Bookmark} size={20} />
    </button>
  );
}

/** Messaggio compresso nel carosello: bolla, nome, anteprima di una riga, ora. */
export function CompactMessage({ m, onClick, label }: { m: MessageDto; onClick: () => void; label: string }) {
  const name = useDisplayName();
  const from = m.from ?? UNKNOWN;
  const preview = (m.bodyTextClean || m.bodyText || '').replace(/\s+/g, ' ').trim();
  return (
    <button type="button" className="pm-msg--compact" onClick={onClick} aria-label={label}>
      <PersonAvatar person={from} size={22} />
      <span className="pm-msg__who">{name(from)}</span>
      <span className="pm-msg__preview">{preview || m.subject || '(vuoto)'}</span>
      {m.important && <Ic icon={Bookmark} size={14} className="pm-bookmark" />}
      <span className="pm-msg__time">{shortDate(m.date)}</span>
    </button>
  );
}

/** Messaggio in focus (D10): intestazione, azioni, corpo, testo citato in fondo. */
export function MessageCard({ m, d, index, total, onCompose }: {
  m: MessageDto;
  d: ConversationDetail;
  index: number;
  total: number;
  onCompose: (r: ComposeRequest) => void;
}) {
  const qc = useQueryClient();
  const name = useDisplayName();
  const [mode, setMode] = useState<'html' | 'text'>('html');
  const [images, setImages] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const [editor, setEditor] = useState<{ target: TagEditorTarget; anchor: DOMRect } | null>(null);
  const marked = useRef<string | null>(null);
  const from = m.from ?? UNKNOWN;
  const files = m.attachments.filter((a) => !a.isInline);
  const showHtml = m.hasHtml && mode === 'html';
  const clean = m.bodyTextClean || '';
  const full = m.bodyText || '';
  const hasQuote = !showHtml && full.trim().length > clean.trim().length + 20;

  // Aprire un messaggio lo segna come letto (su Gmail al prossimo batch).
  useEffect(() => {
    if (m.seen || m.direction !== 'in' || marked.current === m.id) return;
    marked.current = m.id;
    void api.markMessageRead(m.id).then(() => {
      for (const k of [['conversation', d.id], ['conversations'], ['counts'], ['projects']]) qc.invalidateQueries({ queryKey: k });
    });
  }, [m, d.id, qc]);

  const compose = (r: Omit<ComposeRequest, 'projectId' | 'conversationId'>) => onCompose({ ...r, projectId: d.projectId, conversationId: d.id });
  const openTag = (kind: 'task' | 'note', el: HTMLElement) => {
    const anchor = el.getBoundingClientRect();
    if (kind === 'task') setEditor({ target: { kind: 'task', projectId: d.projectId ?? '', conversationId: d.id, messageId: m.id }, anchor });
    else setEditor({ target: { kind: 'note', conversationId: d.id }, anchor });
  };

  return (
    <article className="pm-msg--focused" aria-posinset={index + 1} aria-setsize={total} aria-label={m.subject ?? 'Messaggio'}>
      <div className="pm-msg__head">
        <PersonAvatar person={from} size={44} />
        <div className="pm-msg__headmain">
          <h1 className="pm-msg__subject">{m.subject || '(nessun oggetto)'}</h1>
          <div>
            <span style={{ fontWeight: 600 }}>{name(from)}</span> <span style={{ color: 'var(--ink-muted)' }}>&lt;{from.email}&gt;</span>
            {m.outgoingStatus === 'queued' && <span style={{ color: 'var(--ink-muted)' }}> · in coda di invio</span>}
            {m.outgoingStatus === 'failed' && <span style={{ color: 'var(--danger)' }}> · invio non riuscito</span>}
          </div>
          {(m.to.length > 0 || m.cc.length > 0) && (
            <div className="pm-msg__recipients">
              a {m.to.map((p) => <PersonChip key={`to-${p.email}`} person={p} />)}
              {m.cc.length > 0 && <>cc {m.cc.map((p) => <PersonChip key={`cc-${p.email}`} person={p} />)}</>}
            </div>
          )}
        </div>
        <div className="pm-msg__meta">
          <span>{longDate(m.date)}</span>
          <ImportantToggle m={m} conversationId={d.id} />
        </div>
      </div>

      <div className="pm-msg__actions">
        <button type="button" className="pm-btn pm-btn--primary" onClick={() => compose({ replyTo: m, replyAll: true })}>
          <Ic icon={ReplyAll} size={17} /> Rispondi a tutti
        </button>
        <button type="button" className="pm-btn pm-btn--secondary" onClick={() => compose({ replyTo: m, replyAll: false })}>
          <Ic icon={Reply} size={17} /> Rispondi al mittente
        </button>
        <button type="button" className="pm-btn pm-btn--secondary" onClick={() => compose({ forward: m })}>
          <Ic icon={Forward} size={17} /> Inoltra
        </button>
        {d.projectId && (
          <button type="button" className="pm-btn pm-btn--secondary" onClick={(e) => openTag('task', e.currentTarget)}>
            <Ic icon={SquareCheck} size={17} /> Crea task
          </button>
        )}
        <button type="button" className="pm-btn pm-btn--secondary" onClick={(e) => openTag('note', e.currentTarget)}>
          <Ic icon={StickyNote} size={17} /> Nota
        </button>
        <span style={{ flex: 1 }} />
        {showHtml && !images && (
          <button type="button" className="pm-btn pm-btn--ghost pm-btn--xs" onClick={() => setImages(true)} title="Le immagini remote sono bloccate per privacy">
            <Ic icon={Image} size={15} /> Mostra immagini
          </button>
        )}
        {m.hasHtml && (
          <span className="pm-seg" role="radiogroup" aria-label="Formato">
            <button type="button" role="radio" className="pm-seg__opt" aria-checked={mode === 'html'} onClick={() => setMode('html')}>
              Originale
            </button>
            <button type="button" role="radio" className="pm-seg__opt" aria-checked={mode === 'text'} onClick={() => setMode('text')}>
              Solo testo
            </button>
          </span>
        )}
      </div>

      <div className="pm-msg__body">
        {showHtml ? (
          <HtmlFrame src={`/api/messages/${m.id}/html${images ? '?images=1' : ''}`} />
        ) : (
          <pre>{(quoted ? full : clean || full).trim() || '(messaggio vuoto)'}</pre>
        )}
      </div>

      {files.length > 0 && (
        <div className="pm-msg__files">
          {files.map((a) => (
            <a key={a.id} className="pm-infochip" href={`/api/attachments/${a.id}`} style={{ textDecoration: 'none' }}>
              <Ic icon={Paperclip} size={15} />
              <span className="pm-truncate" style={{ maxWidth: 240 }}>{a.filename ?? 'allegato'}</span>
              {a.versionCount && a.versionCount > 1 && <span style={{ color: 'var(--ink-muted)' }}>v{a.versionNo} di {a.versionCount}</span>}
              <span style={{ color: 'var(--ink-muted)' }}>{fileSize(a.size)}</span>
            </a>
          ))}
        </div>
      )}

      {hasQuote && (
        <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm pm-msg__quotebtn" aria-expanded={quoted} onClick={() => setQuoted(!quoted)}>
          <Ic icon={quoted ? ChevronUp : ChevronDown} size={15} />
          {quoted ? 'Nascondi testo citato' : `Testo citato${index > 0 ? ` · ${index} ${index === 1 ? 'messaggio precedente' : 'messaggi precedenti'}` : ''}`}
        </button>
      )}
      {editor && <TagEditor target={editor.target} anchor={editor.anchor} onClose={() => setEditor(null)} />}
    </article>
  );
}
