import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Due colonne con divisore trascinabile; la larghezza della sinistra viene ricordata. */
export function Split({ left, right, storageKey, initial = 440, min = 300, max = 900 }: {
  left: ReactNode;
  right: ReactNode;
  storageKey: string;
  initial?: number;
  min?: number;
  max?: number;
}) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current || !container.current) return;
      const x = e.clientX - container.current.getBoundingClientRect().left;
      setWidth(Math.min(max, Math.max(min, x)));
    },
    [min, max],
  );
  const onUp = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onMove, onUp]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {}
  }, [storageKey, width]);

  return (
    <div ref={container} className="flex h-full min-w-0 flex-1">
      <div className="h-full shrink-0 overflow-hidden" style={{ width }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        className="w-1 shrink-0 cursor-col-resize bg-stone-200 hover:bg-sky-400 dark:bg-stone-800"
        onPointerDown={() => {
          dragging.current = true;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />
      <div className="h-full min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}
