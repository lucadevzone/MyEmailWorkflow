import { useEffect, useRef, useState } from 'react';
import type { AnnotationMarkDto, QuoteSelector } from '@mmw/shared';
import { markQuotes, setQuotesHidden } from '../lib/quotes.ts';
import { locateRange, quoteOf } from '../lib/annotations.ts';

const NOTE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/></svg>';
const TASK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><rect x="3" y="3" width="18" height="18" rx="3"/></svg>';

/** Evidenzia i brani annotati e mette alla loro fine un'icona cliccabile (nota o task). */
function renderMarks(doc: Document, marks: AnnotationMarkDto[], onClick: (m: AnnotationMarkDto, rect: DOMRect) => void, frame: HTMLIFrameElement) {
  doc.querySelectorAll('[data-mmw-mark]').forEach((el) => el.remove());
  const win = doc.defaultView as (Window & { Highlight?: new (...r: Range[]) => unknown; CSS?: { highlights?: Map<string, unknown> } }) | null;
  win?.CSS?.highlights?.delete('mmw-ann');
  if (!marks.length || !doc.body) return;
  if (!doc.getElementById('mmw-ann-style')) {
    const st = doc.createElement('style');
    st.id = 'mmw-ann-style';
    st.textContent = '::highlight(mmw-ann){background-color:rgba(251,231,161,.85)}';
    doc.head?.appendChild(st);
  }
  // Prima si trovano tutti i brani (sul testo senza icone), poi si inseriscono le icone dalla fine,
  // così l'inserimento non sposta i brani ancora da marcare.
  const found = marks
    .map((m) => ({ m, range: locateRange(doc.body!, m) }))
    .filter((x): x is { m: AnnotationMarkDto; range: Range } => !!x.range && x.range.getClientRects().length > 0 && x.range.getBoundingClientRect().width > 0);
  const ranges = found.map((x) => x.range);
  for (const { m, range } of [...found].reverse()) {
    const b = doc.createElement('button');
    b.setAttribute('data-mmw-mark', '');
    b.setAttribute('title', `${m.kind === 'task' ? 'Task' : 'Nota'}: ${m.label}`);
    b.setAttribute('aria-label', `${m.kind === 'task' ? 'Apri il task' : 'Apri la nota'}: ${m.label}`);
    b.innerHTML = m.kind === 'task' ? TASK_SVG : NOTE_SVG;
    const bg = m.kind === 'task' ? '#EEF6F0' : '#FBF6E3';
    const fg = m.kind === 'task' ? '#24553F' : '#8A6D12';
    const bd = m.kind === 'task' ? '#B9D8C4' : '#E6D598';
    // Nel testo, come un richiamo: il testo dopo scorre di poco ma resta leggibile.
    b.style.cssText = `display:inline-flex;vertical-align:-4px;margin:0 2px;width:18px;height:18px;padding:0;align-items:center;justify-content:center;border-radius:5px;border:1px solid ${bd};background:${bg};color:${fg};cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.12);opacity:${m.done ? 0.55 : 1}`;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      onClick(m, new DOMRect(f.left + r.left, f.top + r.top, r.width, r.height));
    });
    const at = range.cloneRange();
    at.collapse(false);
    at.insertNode(b);
  }
  if (win?.Highlight && win.CSS?.highlights && ranges.length) win.CSS.highlights.set('mmw-ann', new win.Highlight(...ranges));
}

/**
 * HTML dell'email in un iframe sandbox: niente script (manca allow-scripts),
 * stessa origine solo per misurarne l'altezza; i link si aprono fuori dalla sandbox.
 */
export function HtmlFrame({ src, onSelectText, hideQuotes, onQuotes, marks, onMarkClick }: {
  src: string;
  onSelectText?: (text: string, rect: DOMRect, quote: QuoteSelector) => void;
  /** Brani annotati da evidenziare, con l'icona della nota o del task. */
  marks?: AnnotationMarkDto[];
  onMarkClick?: (m: AnnotationMarkDto, rect: DOMRect) => void;
  /** Nasconde il testo citato (risposte precedenti, messaggi originali inoltrati). */
  hideQuotes?: boolean;
  /** Dice se nel messaggio c'è del testo citato da poter mostrare. */
  onQuotes?: (found: boolean) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const onSelectRef = useRef(onSelectText);
  onSelectRef.current = onSelectText;
  const hideRef = useRef(hideQuotes);
  hideRef.current = hideQuotes;
  const onQuotesRef = useRef(onQuotes);
  onQuotesRef.current = onQuotes;

  const measureRef = useRef<() => void>(() => {});
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const onMarkRef = useRef(onMarkClick);
  onMarkRef.current = onMarkClick;
  const drawMarks = () => {
    const frame = ref.current;
    const doc = frame?.contentDocument;
    if (frame && doc?.body) renderMarks(doc, marksRef.current ?? [], (m, r) => onMarkRef.current?.(m, r), frame);
  };
  useEffect(() => {
    drawMarks();
  }, [marks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cambiando la scelta si mostra o nasconde il testo citato già marcato.
  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) {
      setQuotesHidden(doc, !!hideQuotes);
      measureRef.current();
      drawMarks();
    }
  }, [hideQuotes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      // Testo selezionato dentro l'email: il rettangolo si riporta alle coordinate della pagina.
      const onUp = () => {
        if (!onSelectRef.current) return;
        const sel = doc.getSelection();
        const text = sel?.toString().trim() ?? '';
        if (!sel || sel.rangeCount === 0 || text.length < 2) return;
        const range = sel.getRangeAt(0);
        const r = range.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        onSelectRef.current(text, new DOMRect(f.left + r.left, f.top + r.top, r.width, r.height), quoteOf(doc.body, range));
      };
      doc.addEventListener('mouseup', onUp);
      doc.addEventListener('keyup', (e) => e.shiftKey && onUp());
      // L'iframe è alto quanto il contenuto: niente barre di scorrimento interne.
      doc.documentElement.style.overflow = 'hidden';
      onQuotesRef.current?.(markQuotes(doc));
      setQuotesHidden(doc, !!hideRef.current);
      // Si misura il body (non il documento, che è alto almeno quanto l'iframe e non si accorcia).
      const measure = () => {
        const body = doc.body;
        if (!body) return setHeight(Math.max(40, doc.documentElement.scrollHeight));
        // Estensione reale del contenuto (anche se l'email imposta il body alto quanto la finestra).
        const range = doc.createRange();
        range.selectNodeContents(body);
        const r = range.getBoundingClientRect();
        const cs = doc.defaultView?.getComputedStyle(body);
        const margins = cs ? parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) : 0;
        setHeight(Math.max(32, Math.ceil(r.height + margins)));
      };
      measureRef.current = () => {
        measure();
        drawMarks();
      };
      measure();
      drawMarks();
      observer = new ResizeObserver(() => measureRef.current());
      if (doc.body) {
        observer.observe(doc.body);
        for (const el of doc.body.children) observer.observe(el);
      }
      // Le immagini che finiscono di caricare cambiano l'altezza.
      doc.addEventListener('load', () => measureRef.current(), true);
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
      style={{ height, width: '100%', border: 0, borderRadius: 6, background: '#fff', display: 'block' }}
    />
  );
}
