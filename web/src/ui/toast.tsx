import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

export const useToast = () => useContext(ToastContext);

/** Notifiche brevi con azione opzionale ("Annulla"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback((t: Omit<Toast, 'id'>) => {
    const id = next.current++;
    setToasts((list) => [...list.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 8000);
  }, []);
  const dismiss = (id: number) => setToasts((list) => list.filter((x) => x.id !== id));

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pm-toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pm-toast"
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="pm-toast__action"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
