import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

/**
 * Riordino per trascinamento dalla maniglia (con segnaposto) e da tastiera: sulla maniglia a fuoco
 * Alt+←/→ (asse x) o Alt+↑/↓ (asse y) spostano l'elemento.
 */
export function useSortable(ids: string[], onReorder: (ids: string[]) => void, axis: 'x' | 'y') {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const grabbed = useRef<string | null>(null);

  const rest = dragging ? ids.filter((x) => x !== dragging) : ids;

  const finish = () => {
    if (dragging && dropIndex !== null) {
      const next = [...rest];
      next.splice(dropIndex, 0, dragging);
      if (next.join() !== ids.join()) onReorder(next);
    }
    grabbed.current = null;
    setDragging(null);
    setDropIndex(null);
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
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      const i = rest.indexOf(id);
      setDropIndex(after ? i + 1 : i);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      finish();
    },
    onDragEnd: finish,
  });

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

  /**
   * Sequenza da disegnare: gli elementi nell'ordine attuale (quello trascinato resta al suo posto, sollevato)
   * con il segnaposto dove verrebbe lasciato. Non si sposta l'elemento nel DOM: interromperebbe il trascinamento.
   */
  const layout = (): ({ kind: 'item'; id: string } | { kind: 'slot' })[] => {
    const out: ({ kind: 'item'; id: string } | { kind: 'slot' })[] = [];
    for (const id of ids) {
      if (dragging && id !== dragging && dropIndex === rest.indexOf(id)) out.push({ kind: 'slot' });
      out.push({ kind: 'item', id });
    }
    if (dragging && dropIndex === rest.length) out.push({ kind: 'slot' });
    return out;
  };

  return { dragging, dropIndex, rest, itemProps, gripProps, layout };
}
