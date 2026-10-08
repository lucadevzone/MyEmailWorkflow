// Menu contestuale: barra flottante ancorata sopra l'elemento (azioni suggerite, poi principali,
// poi "Altro") che si trasforma nella palette con ricerca. Da tastiera (tasto menu o Maiusc+F10)
// si apre direttamente la palette. Le azioni con `confirm` passano dal popup a semicerchio.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { useConfirm, type ConfirmOptions } from './confirm.tsx';

export interface MenuAction {
  id: string;
  label: string;
  icon: string;
  run: () => void | Promise<unknown>;
  /** "ai" = suggerita dall'analizzatore (viola), "danger" = distruttiva. */
  tone?: 'ai' | 'danger';
  /** Mostrata nella barra (oltre alle suggerite); le altre solo nella palette. */
  primary?: boolean;
  confirm?: ConfirmOptions;
  /** Testo in più per la ricerca nella palette. */
  keywords?: string;
}

export interface MenuSpec {
  title?: string;
  actions: MenuAction[];
}

interface OpenMenu extends MenuSpec {
  rect: DOMRect;
  mode: 'bar' | 'palette';
  query: string;
  restore: HTMLElement | null;
}

type Open = (spec: MenuSpec, target: HTMLElement, mode?: 'bar' | 'palette', query?: string) => void;
const MenuContext = createContext<Open>(() => {});

/** Apertura programmatica (es. "Sposta in…" riapre la palette già filtrata). */
export const useOpenMenu = () => useContext(MenuContext);

const MAX_SUGGESTED_IN_BAR = 2;

/**
 * Props da applicare a un elemento per dargli il menu contestuale (tasto destro, tasto menu, Maiusc+F10).
 * `getSpec` è chiamata all'apertura, così le azioni riflettono lo stato del momento.
 */
export function useContextMenu(getSpec: () => MenuSpec | null) {
  const open = useContext(MenuContext);
  return {
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      const spec = getSpec();
      if (!spec) return;
      e.preventDefault();
      e.stopPropagation();
      open(spec, e.currentTarget, 'bar');
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        const spec = getSpec();
        if (!spec) return;
        e.preventDefault();
        open(spec, e.currentTarget, 'palette');
      }
    },
  };
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const ask = useConfirm();

  const open: Open = useCallback((spec, target, mode = 'bar', query = '') => {
    setMenu({ ...spec, rect: target.getBoundingClientRect(), mode, query, restore: target });
  }, []);

  const close = useCallback(() => {
    setMenu((m) => {
      m?.restore?.focus?.({ preventScroll: true });
      return null;
    });
  }, []);

  const run = useCallback(
    async (a: MenuAction) => {
      setMenu(null);
      if (a.confirm && !(await ask(a.confirm))) return;
      await a.run();
    },
    [ask],
  );

  return (
    <MenuContext.Provider value={open}>
      {children}
      {menu && (
        <div className="fixed inset-0 z-40" onPointerDown={(e) => e.target === e.currentTarget && close()} onContextMenu={(e) => e.preventDefault()}>
          {menu.mode === 'bar' ? (
            <Bar menu={menu} onRun={run} onClose={close} onPalette={(query) => setMenu({ ...menu, mode: 'palette', query })} />
          ) : (
            <Palette menu={menu} onRun={run} onClose={close} />
          )}
        </div>
      )}
    </MenuContext.Provider>
  );
}

/** Posizione: sopra l'elemento se c'è spazio, altrimenti sotto; sempre dentro lo schermo. */
function anchor(rect: DOMRect, width: number, height: number) {
  const above = rect.top > height + 16;
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8);
  const top = above ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 8);
  return { left, top };
}

const toneCls = (a: MenuAction) =>
  a.tone === 'ai'
    ? 'bg-violet-100 text-violet-800 hover:bg-violet-200 focus-visible:bg-violet-200 dark:bg-violet-900/50 dark:text-violet-200'
    : a.tone === 'danger'
      ? 'text-rose-700 hover:bg-rose-50 focus-visible:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40'
      : 'hover:bg-stone-100 focus-visible:bg-stone-100 dark:hover:bg-stone-800 dark:focus-visible:bg-stone-800';

function Bar({ menu, onRun, onClose, onPalette }: { menu: OpenMenu; onRun: (a: MenuAction) => void; onClose: () => void; onPalette: (q: string) => void }) {
  const suggested = menu.actions.filter((a) => a.tone === 'ai').slice(0, MAX_SUGGESTED_IN_BAR);
  const main = menu.actions.filter((a) => a.primary && a.tone !== 'ai');
  const hasMore = menu.actions.length > suggested.length + main.length;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 360, h: 40 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSize({ w: el.offsetWidth, h: el.offsetHeight });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  const onKey = (e: ReactKeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowRight') buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === 'ArrowLeft') buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === 'ArrowDown') onPalette('');
    // Cominciare a scrivere apre la palette con la ricerca.
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && /\S/.test(e.key)) {
      e.preventDefault();
      onPalette(e.key);
    } else return;
    e.preventDefault();
  };

  const pos = anchor(menu.rect, size.w, size.h);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.title ?? 'Azioni'}
      onKeyDown={onKey}
      className="absolute flex max-w-[calc(100vw-16px)] items-center gap-0.5 rounded-full border border-stone-300 bg-white p-1 shadow-lg dark:border-stone-600 dark:bg-stone-900"
      style={pos}
    >
      {[...suggested, ...main].map((a) => (
        <button
          key={a.id}
          role="menuitem"
          onClick={() => onRun(a)}
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm outline-none ${toneCls(a)}`}
        >
          <Icon name={a.icon} size={18} />
          <span className="max-w-56 truncate">{a.label}</span>
        </button>
      ))}
      {hasMore && (
        <button role="menuitem" onClick={() => onPalette('')} className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-sm text-stone-600 outline-none hover:bg-stone-100 focus-visible:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800">
          <Icon name="more_horiz" size={18} /> Altro
        </button>
      )}
    </div>
  );
}

function Palette({ menu, onRun, onClose }: { menu: OpenMenu; onRun: (a: MenuAction) => void; onClose: () => void }) {
  const [q, setQ] = useState(menu.query);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const match = (a: MenuAction) => !ql || `${a.label} ${a.keywords ?? ''}`.toLowerCase().includes(ql);
    // Prima le suggerite, poi le altre: l'ordine dell'elenco è anche quello della navigazione.
    return [...menu.actions.filter((a) => a.tone === 'ai' && match(a)), ...menu.actions.filter((a) => a.tone !== 'ai' && match(a))];
  }, [q, menu.actions]);

  useEffect(() => {
    input.current?.focus();
    const len = input.current?.value.length ?? 0;
    input.current?.setSelectionRange(len, len);
  }, []);
  useEffect(() => setSel(0), [q]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, list.length - 1));
    else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0));
    else if (e.key === 'Enter' && list[sel]) onRun(list[sel]);
    else return;
    e.preventDefault();
  };

  const firstOther = list.findIndex((a) => a.tone !== 'ai');
  // Posizione decisa all'apertura: filtrando la lista si accorcia, ma la palette non deve saltare.
  const [pos] = useState(() => anchor(menu.rect, 320, Math.min(56 + menu.actions.length * 36 + 40, 420)));
  return (
    <div role="dialog" aria-label={menu.title ?? 'Azioni'} className="absolute w-80 rounded-xl border border-stone-300 bg-white p-1.5 shadow-xl dark:border-stone-600 dark:bg-stone-900" style={pos} onKeyDown={onKey}>
      {menu.title && <div className="truncate px-2 pb-1 pt-0.5 text-xs text-stone-500">{menu.title}</div>}
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Cerca un'azione"
        aria-label="Cerca un'azione"
        className="mb-1 h-8 w-full rounded-md border border-stone-200 bg-transparent px-2 text-sm outline-none focus:border-stone-400 dark:border-stone-700"
      />
      <ul role="listbox" className="max-h-80 overflow-y-auto">
        {list.length === 0 && <li className="px-2 py-2 text-sm text-stone-500">Nessuna azione.</li>}
        {list.map((a, i) => (
          <li key={a.id}>
            {i === 0 && a.tone === 'ai' && <div className="px-2 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-stone-400">Suggerite</div>}
            {i === firstOther && <div className="px-2 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-stone-400">Azioni</div>}
            <button
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => onRun(a)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${i === sel ? 'bg-stone-100 dark:bg-stone-800' : ''} ${
                a.tone === 'ai' ? 'text-violet-800 dark:text-violet-200' : a.tone === 'danger' ? 'text-rose-700 dark:text-rose-300' : ''
              }`}
            >
              <Icon name={a.icon} size={18} className={a.tone ? '' : 'text-stone-500'} />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
