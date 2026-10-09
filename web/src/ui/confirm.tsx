import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export interface ConfirmOptions {
  message: string;
  /** Testo del pulsante OK (mostrato al passaggio del mouse e letto dagli screen reader). */
  okLabel?: string;
  /** Operazione distruttiva: OK rosso e focus iniziale su Annulla. */
  danger?: boolean;
}

type Ask = (opts: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<Ask>(async () => false);

/** Chiede conferma con il popup a semicerchio, ancorato al punto dell'ultimo clic. */
export const useConfirm = () => useContext(ConfirmContext);

interface Pending extends ConfirmOptions {
  x: number;
  y: number;
  resolve: (ok: boolean) => void;
}

const R = 58; // raggio dell'arco
const BTN = 44;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [shown, setShown] = useState(false);
  const last = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Il punto dell'ultimo clic: il popup compare lì, vicino all'elemento su cui si sta agendo.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      last.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  const ask: Ask = useCallback(
    (opts) =>
      new Promise<boolean>((resolve) => {
        const o = typeof opts === 'string' ? { message: opts } : opts;
        setPending({ ...o, ...last.current, resolve });
        setShown(false);
        requestAnimationFrame(() => setShown(true));
      }),
    [],
  );

  const close = useCallback(
    (ok: boolean) => {
      if (!pending) return;
      pending.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    (pending.danger ? cancelRef : okRef).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      // Invio conferma il pulsante col focus (Annulla, per le operazioni distruttive).
      if (e.key === 'Enter') {
        e.preventDefault();
        close(document.activeElement === okRef.current);
      }
      if (e.key === 'ArrowLeft') cancelRef.current?.focus();
      if (e.key === 'ArrowRight') okRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  let layout = null;
  if (pending) {
    // Arco sopra il punto, oppure sotto se si è vicini al bordo superiore; mai fuori dallo schermo.
    const up = pending.y > 150;
    const x = Math.min(Math.max(pending.x, R + BTN), window.innerWidth - R - BTN);
    const y = pending.y;
    const dir = up ? -1 : 1;
    const at = (deg: number) => ({ left: x + Math.cos((deg * Math.PI) / 180) * R, top: y + dir * Math.sin((deg * Math.PI) / 180) * R });
    layout = { x, y, up, cancel: at(140), ok: at(40), labelTop: y + dir * (R + BTN / 2 + 10) };
  }


  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && layout && (
        <div className="pm-confirm" onPointerDown={(e) => e.target === e.currentTarget && close(false)} role="alertdialog" aria-label={pending.message} aria-modal="true">
          <div
            className="pm-confirm__label"
            style={{ left: layout.x, top: layout.labelTop, transform: `translate(-50%, ${layout.up ? '-100%' : '0'})`, opacity: shown ? 1 : 0 }}
          >
            {pending.message}
          </div>
          <span className="pm-confirm__origin" style={{ left: layout.x, top: layout.y }} />
          <button
            ref={cancelRef}
            className="pm-confirm__btn pm-confirm__btn--cancel"
            style={{ width: BTN, height: BTN, left: layout.cancel.left, top: layout.cancel.top, transform: `translate(-50%,-50%) scale(${shown ? 1 : 0.4})`, opacity: shown ? 1 : 0 }}
            onClick={() => close(false)}
            title="Annulla (Esc)"
            aria-label="Annulla"
          >
            <Icon name="close" size={22} />
          </button>
          <button
            ref={okRef}
            className={`pm-confirm__btn ${pending.danger ? 'pm-confirm__btn--danger' : 'pm-confirm__btn--ok'}`}
            style={{ width: BTN, height: BTN, left: layout.ok.left, top: layout.ok.top, transform: `translate(-50%,-50%) scale(${shown ? 1 : 0.4})`, opacity: shown ? 1 : 0, transitionDelay: '30ms' }}
            onClick={() => close(true)}
            title={`${pending.okLabel ?? 'OK'} (Invio)`}
            aria-label={pending.okLabel ?? 'OK'}
          >
            <Icon name="check" size={22} />
          </button>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
