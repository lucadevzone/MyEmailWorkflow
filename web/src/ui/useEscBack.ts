import { useEffect } from 'react';

/**
 * Esc nelle pagine di impostazioni: torna indietro. Non mentre si scrive in un campo (si perderebbero
 * le modifiche) né quando è aperto un menu o una conferma, che gestiscono Esc da soli.
 */
export function useEscBack(back: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) {
        t.blur();
        return;
      }
      if (document.querySelector('.pm-confirm, [role=menu]')) return;
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}
