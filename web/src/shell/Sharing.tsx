// Uso su più PC (docs/03-uso-su-piu-pc.md): fascia sul PC che non ha il database, presa automatica quando
// il database è libero e si sta usando questo PC, segnale di attività per il rilascio dopo N minuti.

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RefreshCw } from 'lucide-react';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useToast } from '../ui/toast.tsx';

export function useSharingStatus() {
  return useQuery({ queryKey: ['sharing'], queryFn: api.sharingStatus, refetchInterval: (q) => (q.state.data?.state === 'disabled' ? false : 10_000) });
}

const ago = (t: number | null) => {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s fa` : s < 3600 ? `${Math.round(s / 60)} min fa` : `${Math.round(s / 3600)} h fa`;
};

/**
 * Montato una volta nell'app: segnala l'attività dell'utente (al più una volta al minuto) e prende il
 * database da solo quando è libero, la finestra è in primo piano e l'utente la sta usando.
 */
export function SharingPresence() {
  const qc = useQueryClient();
  const { data: st } = useSharingStatus();
  const lastPing = useRef(0);
  const trying = useRef(false);

  useEffect(() => {
    if (!st || st.state === 'disabled') return;
    const onUse = () => {
      const now = Date.now();
      if (now - lastPing.current < 60_000) return;
      lastPing.current = now;
      void api.sharingActivity().catch(() => {});
    };
    window.addEventListener('pointerdown', onUse);
    window.addEventListener('keydown', onUse);
    return () => {
      window.removeEventListener('pointerdown', onUse);
      window.removeEventListener('keydown', onUse);
    };
  }, [st?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // Libero e questa finestra è in uso: lo si prende senza chiedere.
  useEffect(() => {
    if (!st || (st.state !== 'waiting' && st.state !== 'syncing') || st.lease?.holderId || st.error) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus() || trying.current) return;
    trying.current = true;
    void api
      .sharingAcquire()
      .then(() => qc.invalidateQueries())
      .catch(() => qc.invalidateQueries({ queryKey: ['sharing'] }))
      .finally(() => (trying.current = false));
  }, [st, qc]);
  return null;
}

/** Fascia sotto la barra in alto quando questo PC non ha il database. */
export function SharingBanner() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: st } = useSharingStatus();
  const [busy, setBusy] = useState(false);
  if (!st || st.state === 'disabled' || st.state === 'holder') return null;
  const holder = st.lease?.holderName;
  const take = async (force: boolean) => {
    setBusy(true);
    try {
      if (holder && !force) {
        await api.sharingRequestRelease();
        toast({ text: `Richiesta inviata a ${holder}: il database passa qui appena lo consegna` });
      } else {
        await api.sharingAcquire(force);
        await qc.invalidateQueries();
        toast({ text: 'Ora il database è su questo PC' });
      }
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['sharing'] });
    }
  };
  return (
    <div className="pm-sharebar" role="status">
      <Ic icon={st.state === 'syncing' ? RefreshCw : Lock} size={15} className={st.state === 'syncing' ? 'pm-spin' : undefined} />
      <span className="pm-sharebar__text">
        {st.error
          ? st.error
          : st.state === 'syncing'
            ? `Google Drive sta scaricando l'ultima versione dei dati (versione ${st.lease?.version ?? '?'})…`
            : holder
              ? <>Il database è in uso su <strong>{holder}</strong> · ultimo segnale {ago(st.lease?.heartbeat ?? null)}{st.lease?.releaseRequestedBy ? ' · rilascio richiesto' : ''} — qui puoi solo consultare.</>
              : 'Il database è libero.'}
      </span>
      <span className="pm-spacer" />
      {!st.error && st.state === 'waiting' && (
        <>
          <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" disabled={busy} onClick={() => void take(false)}>
            Usa qui
          </button>
          {st.holderStale && (
            <button type="button" className="pm-btn pm-btn--danger pm-btn--sm" disabled={busy} onClick={() => void take(true)} title="Il PC che ha il database non dà segni: si riparte dall'ultima versione consegnata">
              Usa qui comunque
            </button>
          )}
        </>
      )}
    </div>
  );
}
