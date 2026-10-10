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

/** Il menu si ancora a un elemento oppure a un rettangolo qualsiasi (es. il testo selezionato). */
type Open = (spec: MenuSpec, target: HTMLElement | DOMRect, mode?: 'bar' | 'palette', query?: string, at?: DOMRect) => void;
const MenuContext = createContext<Open>(() => {});

/** Apertura programmatica (es. "Sposta in…" riapre la palette già filtrata). */
export const useOpenMenu = () => useContext(MenuContext);

const MAX_SUGGESTED_IN_BAR = 2;

/** Punto del clic con il mouse (il menu compare lì); da tastiera nessun punto: si ancora all'elemento. */
const pointOf = (e: ReactMouseEvent) => (e.clientX || e.clientY ? new DOMRect(e.clientX, e.clientY, 0, 0) : undefined);

/**
 * Menu contestuale da un gestore qualsiasi (anche dentro un elenco, dove non si può usare un hook per voce):
 * `menuAt(spec)` restituisce il gestore di onContextMenu, che apre il menu nel punto del clic.
 */
export function useMenuAt() {
  const open = useContext(MenuContext);
  return (getSpec: () => MenuSpec | null) => (e: ReactMouseEvent<HTMLElement>) => {
    const spec = getSpec();
    if (!spec) return;
    e.preventDefault();
    e.stopPropagation();
    open(spec, e.currentTarget, 'bar', '', pointOf(e));
  };
}

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
      open(spec, e.currentTarget, 'bar', '', pointOf(e));
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

  const open: Open = useCallback((spec, target, mode = 'bar', query = '', at) => {
    const el = target instanceof HTMLElement ? target : null;
    setMenu({ ...spec, rect: at ?? (el ? el.getBoundingClientRect() : (target as DOMRect)), mode, query, restore: el });
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
        <div className="pm-ctx-layer" onPointerDown={(e) => e.target === e.currentTarget && close()} onContextMenu={(e) => e.preventDefault()}>
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
  return { left, top: Math.max(8, top) };
}

const toneCls = (a: MenuAction) => (a.tone ? ` pm-ctx--${a.tone}` : '');

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
      className="pm-ctx-bar"
      style={pos}
    >
      {[...suggested, ...main].map((a) => (
        <button
          key={a.id}
          role="menuitem"
          onClick={() => onRun(a)}
          className={`pm-ctx-bar__item${toneCls(a)}`}
        >
          <Icon name={a.icon} size={18} />
          <span className="pm-truncate" style={{ maxWidth: 224 }}>{a.label}</span>
        </button>
      ))}
      {hasMore && (
        <button role="menuitem" onClick={() => onPalette('')} className="pm-ctx-bar__item pm-ctx--more">
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
    <div role="dialog" aria-label={menu.title ?? 'Azioni'} className="pm-ctx-palette" style={pos} onKeyDown={onKey}>
      {menu.title && <div className="pm-ctx-palette__title pm-truncate">{menu.title}</div>}
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Cerca un'azione"
        aria-label="Cerca un'azione"
        className="pm-ctx-palette__input"
      />
      <ul role="listbox" className="pm-ctx-palette__list">
        {list.length === 0 && <li className="pm-ctx-palette__empty">Nessuna azione.</li>}
        {list.map((a, i) => (
          <li key={a.id}>
            {i === 0 && a.tone === 'ai' && <div className="pm-ctx-palette__group">Suggerite</div>}
            {i === firstOther && <div className="pm-ctx-palette__group">Azioni</div>}
            <button
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => onRun(a)}
              className={`pm-ctx-palette__item${toneCls(a)}`}
            >
              <Icon name={a.icon} size={18} className={a.tone ? '' : 'pm-muted'} />
              <span className="pm-truncate" style={{ flex: 1, minWidth: 0 }}>{a.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
