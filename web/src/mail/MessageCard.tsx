import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Bookmark, ChevronsDownUp, ChevronsUpDown, Forward, Image, Paperclip, ReplyAll, StickyNote } from 'lucide-react';
import type { AnnotationMarkDto, ConversationDetail, MessageDto, QuoteSelector } from '@mmw/shared';
import { findQuote, quoteOf } from '../lib/annotations.ts';
import { api } from '../api.ts';
import { fileSize, longDate, shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { Icon } from '../ui/Icon.tsx';
import { PersonAvatar, PersonChip, useDisplayName } from '../ui/People.tsx';
import { useToast } from '../ui/toast.tsx';
import { HtmlFrame } from '../workspace/HtmlFrame.tsx';
import type { ComposeRequest } from '../workspace/pane.ts';
import { useOpenMenu } from '../ui/contextMenu.tsx';
import { TagEditor, type TagEditorTarget } from '../project/TagEditor.tsx';
import { useBlockSend } from '../activities/blockSend.ts';

/** Testo citato come in una risposta ("> " su ogni riga). */
const quoteText = (t: string) => t.split('\n').map((l) => `> ${l}`).join('\n');

/** Titolo di un task ricavato dalla selezione: la prima riga, accorciata. */
function taskTitle(t: string): string {
  const line = t.replace(/\s+/g, ' ').trim();
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}

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

/**
 * Anteprima di un messaggio vicino a quello in focus: più stretta, su fondo grigio, con le prime
 * righe del testo pulito (senza citazioni). Un clic lo porta in focus.
 */
export function PreviewMessage({ m, onClick, label }: { m: MessageDto; onClick: () => void; label: string }) {
  const name = useDisplayName();
  const from = m.from ?? UNKNOWN;
  const text = (m.bodyTextClean || m.bodyText || '').trim();
  return (
    <button type="button" className="pm-msg--preview" onClick={onClick} aria-label={label}>
      <span className="pm-msg__previewhead">
        <PersonAvatar person={from} size={24} />
        <span className="pm-msg__who">{name(from)}</span>
        <span style={{ flex: 1 }} />
        {m.important && <Ic icon={Bookmark} size={14} className="pm-bookmark" />}
        <span className="pm-msg__time">{shortDate(m.date)}</span>
      </span>
      <span className="pm-msg__previewtext">{text || m.subject || '(vuoto)'}</span>
    </button>
  );
}

/** Messaggio in focus (D10): intestazione, azioni, corpo, testo citato in fondo. */
export function MessageCard({ m, d, index, total, onCompose, active = true }: {
  m: MessageDto;
  /** In focus: solo allora il messaggio si segna come letto. */
  active?: boolean;
  d: ConversationDetail;
  index: number;
  total: number;
  onCompose: (r: ComposeRequest) => void;
}) {
  const qc = useQueryClient();
  const name = useDisplayName();
  const [images, setImages] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const marked = useRef<string | null>(null);
  const openMenu = useOpenMenu();
  const pre = useRef<HTMLPreElement>(null);
  const [editor, setEditor] = useState<{ target: TagEditorTarget; anchor: DOMRect } | null>(null);
  const from = m.from ?? UNKNOWN;
  const files = m.attachments.filter((a) => !a.isInline);
  const showHtml = m.hasHtml;
  const clean = m.bodyTextClean || '';
  const full = m.bodyText || '';
  const [htmlQuotes, setHtmlQuotes] = useState(false);
  const hasQuote = showHtml ? htmlQuotes : full.trim().length > clean.trim().length + 20;

  // Aprire un messaggio lo segna come letto (su Gmail al prossimo batch).
  useEffect(() => {
    if (!active || m.seen || m.direction !== 'in' || marked.current === m.id) return;
    marked.current = m.id;
    void api.markMessageRead(m.id).then(() => {
      for (const k of [['conversation', d.id], ['conversations'], ['counts'], ['projects']]) qc.invalidateQueries({ queryKey: k });
    });
  }, [m, d.id, qc, active]);

  const compose = (r: Omit<ComposeRequest, 'projectId' | 'conversationId'>) => onCompose({ ...r, projectId: d.projectId, conversationId: d.id });
  const toast = useToast();
  const block = useBlockSend();
  // Task di default "Rispondere a…": si chiude da solo quando rispondo.
  const remindReply = () =>
    void api.remindReply(d.id, m.id).then(() => {
      for (const k of [['tasks'], ['conversations'], ['conversation', d.id]]) qc.invalidateQueries({ queryKey: k });
      toast({ text: 'Task «Rispondere a…» creato' });
    });

  // Testo selezionato nel messaggio: menu con rispondi citando, crea nota, crea task.
  const onSelectText = (text: string, rect: DOMRect, quote?: QuoteSelector) => {
    openMenu(
      {
        title: `«${taskTitle(text).slice(0, 60)}${text.length > 60 ? '…' : ''}»`,
        actions: [
          { id: 'quote', icon: 'format_quote', label: 'Rispondi citando', primary: true, run: () => compose({ replyTo: m, replyAll: true, draft: `${quoteText(text)}\n\n` }) },
          {
            id: 'note', icon: 'sticky_note_2', label: 'Crea una nota', primary: true,
            run: () => setEditor({ target: { kind: 'note', conversationId: d.id, messageId: m.id, initialBody: `${quoteText(text)}\n\n`, quote }, anchor: rect }),
          },
          ...(d.projectId
            ? [
                {
                  id: 'task', icon: 'assignment', label: 'Crea un task', primary: true,
                  run: () =>
                    setEditor({
                      target: {
                        kind: 'task' as const,
                        projectId: d.projectId!,
                        conversationId: d.id,
                        messageId: m.id,
                        initialTitle: taskTitle(text),
                        initialBody: text.length > 100 || text.includes('\n') ? quoteText(text) : '',
                        quote,
                      },
                      anchor: rect,
                    }),
                },
              ]
            : []),
          { id: 'copy', icon: 'content_copy', label: 'Copia', run: () => void navigator.clipboard?.writeText(text) },
        ],
      },
      rect,
      'bar',
    );
  };
  const onTextMouseUp = (e: React.MouseEvent | React.KeyboardEvent) => {
    if ('shiftKey' in e && e.type === 'keyup' && !e.shiftKey) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!sel || sel.rangeCount === 0 || text.length < 2 || !(e.currentTarget as HTMLElement).contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    onSelectText(text, range.getBoundingClientRect(), pre.current ? quoteOf(pre.current, range) : undefined);
  };

  // Brani annotati (note e task nati da una selezione): evidenziati, con l'icona che apre l'elemento.
  const { data: marks = [] } = useQuery({ queryKey: ['annotations', m.id], queryFn: () => api.annotations(m.id), enabled: active });
  const { data: convTasks = [] } = useQuery({ queryKey: ['tasks', 'conversation', d.id], queryFn: () => api.conversationTasks(d.id), enabled: active && marks.some((x) => x.kind === 'task') });
  const openMark = (mk: AnnotationMarkDto, anchor: DOMRect) => {
    if (mk.kind === 'note') {
      const note = d.notes.find((n) => n.id === mk.itemId);
      if (note) setEditor({ target: { kind: 'note', note, conversationId: d.id }, anchor });
    } else {
      const task = convTasks.find((t) => t.id === mk.itemId);
      if (task && task.projectId) setEditor({ target: { kind: 'task', task, projectId: task.projectId, conversationId: d.id }, anchor });
    }
  };
  /** Testo semplice con i brani annotati evidenziati e l'icona alla fine di ciascuno. */
  const textWithMarks = (text: string) => {
    const found = marks
      .map((mk) => ({ mk, at: findQuote(text, mk) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at);
    const out: React.ReactNode[] = [];
    let pos = 0;
    for (const { mk, at } of found) {
      if (at < pos) continue; // brani sovrapposti: si mostra il primo
      const end = at + mk.exact.length;
      out.push(text.slice(pos, at), <mark key={`${mk.annotationId}-${mk.itemId}-m`} className="pm-annot">{text.slice(at, end)}</mark>);
      out.push(
        <button
          key={`${mk.annotationId}-${mk.itemId}-b`}
          type="button"
          className={`pm-annot__badge pm-annot__badge--${mk.kind}${mk.done ? ' pm-annot__badge--done' : ''}`}
          title={`${mk.kind === 'task' ? 'Task' : 'Nota'}: ${mk.label}`}
          aria-label={`${mk.kind === 'task' ? 'Apri il task' : 'Apri la nota'}: ${mk.label}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => openMark(mk, e.currentTarget.getBoundingClientRect())}
        >
          {mk.kind === 'task' ? <Icon name="assignment" size={13} /> : <Ic icon={StickyNote} size={12} />}
        </button>,
      );
      pos = end;
    }
    out.push(text.slice(pos));
    return out;
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
            {(m.outgoingStatus === 'queued' || m.outgoingStatus === 'failed') && (
              <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" style={{ marginLeft: 8 }} title="Non inviare: rimetti la mail in bozza per modificarla"
                onClick={() => void block.byMessage(m.id)}>
                Blocca invio
              </button>
            )}
          </div>
          {(m.to.length > 0 || m.cc.length > 0) && (
            <div className="pm-msg__recipients">
              a {m.to.map((p) => <PersonChip key={`to-${p.email}`} person={p} />)}
              {m.cc.length > 0 && <>cc {m.cc.map((p) => <PersonChip key={`cc-${p.email}`} person={p} />)}</>}
            </div>
          )}
        </div>
        <div className="pm-msg__side">
          <div className="pm-msg__meta">
            <span>{longDate(m.date)}</span>
            <ImportantToggle m={m} conversationId={d.id} />
          </div>
          <div className="pm-msg__actions">
            {showHtml && !images && (
              <button type="button" className="pm-iconbtn pm-iconbtn--sm" onClick={() => setImages(true)} aria-label="Mostra immagini" title="Mostra immagini (bloccate per privacy)">
                <Ic icon={Image} size={17} />
              </button>
            )}
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={() => compose({ forward: m })}>
              <Ic icon={Forward} size={15} /> Inoltra
            </button>
            <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" onClick={() => compose({ replyTo: m, replyAll: true })}>
              <Ic icon={ReplyAll} size={15} /> Rispondi a tutti
            </button>
            {d.projectId && m.direction === 'in' && (
              <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={remindReply} title="Crea il task «Rispondere a…»: si chiude da solo quando rispondi">
                <Ic icon={AlarmClock} size={15} /> Ricordami di rispondere
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="pm-msg__body" onMouseUp={onTextMouseUp} onKeyUp={onTextMouseUp}>
        {showHtml ? (
          <HtmlFrame
            src={`/api/messages/${m.id}/html${images ? '?images=1' : ''}`}
            onSelectText={onSelectText}
            hideQuotes={!quoted}
            onQuotes={setHtmlQuotes}
            marks={marks}
            onMarkClick={openMark}
          />
        ) : (
          <pre ref={pre}>{textWithMarks((quoted ? full : clean || full).trim() || '(messaggio vuoto)')}</pre>
        )}
      </div>
      {hasQuote && (
        <button
          type="button"
          className="pm-btn pm-btn--ghost pm-btn--xs pm-msg__quotebtn"
          aria-expanded={quoted}
          onClick={() => setQuoted(!quoted)}
          title={quoted ? 'Nascondi il testo citato' : 'Mostra il messaggio completo, con il testo citato'}
        >
          <Ic icon={quoted ? ChevronsDownUp : ChevronsUpDown} size={15} />
          {quoted ? 'Nascondi testo citato' : 'Mostra testo citato'}
        </button>
      )}

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

      {/* Fuori dal carosello (traslato): un popover fixed dentro di lui sarebbe posizionato male. */}
      {editor && createPortal(<TagEditor target={editor.target} anchor={editor.anchor} onClose={() => setEditor(null)} />, document.body)}
    </article>
  );
}
