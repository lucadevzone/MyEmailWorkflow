import { useEffect, useRef, useState } from 'react';
import { markQuotes, setQuotesHidden } from '../lib/quotes.ts';

/**
 * HTML dell'email in un iframe sandbox: niente script (manca allow-scripts),
 * stessa origine solo per misurarne l'altezza; i link si aprono fuori dalla sandbox.
 */
export function HtmlFrame({ src, onSelectText, hideQuotes, onQuotes }: {
  src: string;
  onSelectText?: (text: string, rect: DOMRect) => void;
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

  // Cambiando la scelta si mostra o nasconde il testo citato già marcato.
  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) {
      setQuotesHidden(doc, !!hideQuotes);
      measureRef.current();
    }
  }, [hideQuotes]);

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
        const r = sel.getRangeAt(0).getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        onSelectRef.current(text, new DOMRect(f.left + r.left, f.top + r.top, r.width, r.height));
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
      measureRef.current = measure;
      measure();
      observer = new ResizeObserver(measure);
      if (doc.body) {
        observer.observe(doc.body);
        for (const el of doc.body.children) observer.observe(el);
      }
      // Le immagini che finiscono di caricare cambiano l'altezza.
      doc.addEventListener('load', measure, true);
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
