import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

/**
 * Riordino per trascinamento dalla maniglia e da tastiera (UI v2, trascinamento semplificato):
 * l'elemento trascinato si sposta subito nella nuova posizione e gli altri gli fanno posto, senza
 * segnaposto. Sulla maniglia a fuoco Alt+←/→ (asse x) o Alt+↑/↓ (asse y) spostano l'elemento.
 */
export function useSortable(ids: string[], onReorder: (ids: string[], moved: string) => void, axis: 'x' | 'y') {
  const [dragging, setDragging] = useState<string | null>(null);
  const grabbed = useRef<string | null>(null);

  const reset = () => {
    grabbed.current = null;
    setDragging(null);
  };

  const itemProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      if (grabbed.current !== id) return e.preventDefault();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      setDragging(id);
    },
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      if (id === dragging) return;
      // Sposta subito l'elemento trascinato prima o dopo quello sotto il puntatore.
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      const rest = ids.filter((x) => x !== dragging);
      const i = rest.indexOf(id);
      rest.splice(after ? i + 1 : i, 0, dragging);
      if (rest.join() !== ids.join()) onReorder(rest, dragging);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      reset();
    },
    onDragEnd: reset,
  });

  /** Classe dell'elemento trascinato (leggermente sollevato). */
  const itemClass = (id: string) => (dragging === id ? ' pm-dragging' : '');

  const gripProps = (id: string) => ({
    'data-sort-grip': id,
    onPointerDown: () => (grabbed.current = id),
    onKeyDown: (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const fwd = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== back && e.key !== fwd) return;
      e.preventDefault();
      const i = ids.indexOf(id);
      const j = e.key === back ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      const next = [...ids];
      next.splice(i, 1);
      next.splice(j, 0, id);
      onReorder(next, id);
      // Spostando i nodi la maniglia perde il fuoco: lo si rimette, per poter premere ancora.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-sort-grip="${CSS.escape(id)}"]`)?.focus());
    },
  });

  return { dragging, itemProps, itemClass, gripProps };
}
