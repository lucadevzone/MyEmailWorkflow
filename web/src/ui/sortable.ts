import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

/**
 * Riordino per trascinamento dalla maniglia e da tastiera, come per i task: l'elemento trascinato si
 * attenua e una linea sull'elemento sotto il puntatore indica dove verrà lasciato. Sulla maniglia a
 * fuoco Alt+←/→ (asse x) o Alt+↑/↓ (asse y) spostano l'elemento.
 */
export function useSortable(ids: string[], onReorder: (ids: string[]) => void, axis: 'x' | 'y') {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const grabbed = useRef<string | null>(null);

  const reset = () => {
    grabbed.current = null;
    setDragging(null);
    setOver(null);
  };

  const drop = () => {
    if (dragging && over && over.id !== dragging) {
      const rest = ids.filter((x) => x !== dragging);
      const i = rest.indexOf(over.id);
      rest.splice(over.after ? i + 1 : i, 0, dragging);
      if (rest.join() !== ids.join()) onReorder(rest);
    }
    reset();
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
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      if (over?.id !== id || over.after !== after) setOver({ id, after });
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      drop();
    },
    onDragEnd: reset,
  });

  /** Classi dell'elemento: attenuato se trascinato, linea prima/dopo se è la destinazione. */
  const itemClass = (id: string) => {
    if (dragging === id) return ' pm-sort--dragging';
    if (!dragging || over?.id !== id) return '';
    return ` pm-sort--drop-${over.after ? 'after' : 'before'}-${axis}`;
  };

  const gripProps = (id: string) => ({
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
      onReorder(next);
    },
  });

  return { dragging, itemProps, itemClass, gripProps };
}
