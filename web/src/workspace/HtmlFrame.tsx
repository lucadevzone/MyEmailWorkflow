import { useEffect, useRef, useState } from 'react';

/**
 * HTML dell'email in un iframe sandbox: niente script (manca allow-scripts),
 * stessa origine solo per misurarne l'altezza; i link si aprono fuori dalla sandbox.
 */
export function HtmlFrame({ src, onSelectText }: { src: string; onSelectText?: (text: string, rect: DOMRect) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const onSelectRef = useRef(onSelectText);
  onSelectRef.current = onSelectText;

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
      style={{ height, width: '100%', border: 0, borderRadius: 6, background: '#fff', display: 'block' }}
    />
  );
}
