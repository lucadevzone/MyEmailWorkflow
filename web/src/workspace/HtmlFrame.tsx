import { useEffect, useRef, useState } from 'react';

/**
 * HTML dell'email in un iframe sandbox: niente script (manca allow-scripts),
 * stessa origine solo per misurarne l'altezza; i link si aprono fuori dalla sandbox.
 */
export function HtmlFrame({ src }: { src: string }) {
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
      style={{ height, width: '100%', border: 0, borderRadius: 6, background: '#fff', display: 'block' }}
    />
  );
}
