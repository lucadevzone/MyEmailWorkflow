// Scelta della cartella condivisa (uso su più PC): finestra «Scegli cartella» di macOS aperta dal server,
// e finestra di conferma che spiega cosa verrà scritto (o sostituito) e quanto pesa.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import type { SharingFolderPreviewDto } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useToast } from '../ui/toast.tsx';

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} byte` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB` : `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;

/** Campo della cartella con il pulsante «Scegli…» (finestra di macOS) e le proposte di Google Drive. */
export function FolderField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const toast = useToast();
  const { data: suggested = [] } = useQuery({ queryKey: ['sharing-folders'], queryFn: api.sharingSuggestedFolders });
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    setPicking(true);
    try {
      const r = await api.sharingPickFolder(value || null);
      if (r.folder) onChange(r.folder);
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setPicking(false);
    }
  };
  return (
    <>
      <div className="pm-folderfield">
        <input className="pm-input" placeholder="Nessuna" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label="Cartella condivisa" />
        <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={() => void pick()} disabled={disabled || picking}>
          <Ic icon={FolderOpen} size={15} /> {picking ? 'Scegli nella finestra…' : 'Scegli…'}
        </button>
      </div>
      {!disabled && suggested.length > 0 && (
        <div className="pm-row__sub">
          Google Drive su questo Mac:{' '}
          {suggested.map((f) => (
            <button key={f} type="button" className="pm-linkbtn" onClick={() => onChange(f)}>
              {f.replace(/^.*\/CloudStorage\//, '')}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Conferma prima di usare una cartella: cosa verrà scritto o copiato lì, e quanto pesa. */
export function FolderConfirmDialog({ folder, copy, onConfirm, onClose }: { folder: string; copy: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const preview = useQuery({ queryKey: ['sharing-preview', folder, copy], queryFn: () => api.sharingFolderPreview({ folder, copy }), gcTime: 0, retry: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const p = preview.data;
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pm-modal" onClick={() => !busy && onClose()}>
      <div className="pm-modal__card pm-folderconfirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Usare questa cartella?">
        <h2 className="pm-modal__title">{p?.mode === 'join' ? 'Collegarsi ai dati di questa cartella?' : 'Usare questa cartella?'}</h2>
        <code className="pm-folderconfirm__path">{p?.folder ?? folder}</code>
        {preview.isLoading && <p className="pm-muted">Calcolo della dimensione…</p>}
        {preview.error && <p className="pm-error">{(preview.error as Error).message}</p>}
        {p && <PreviewText p={p} />}
        <div className="pm-inlineform__actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" disabled={busy} onClick={onClose}>Annulla</button>
          <button
            type="button"
            className={`pm-btn pm-btn--sm ${p?.mode === 'join' ? 'pm-btn--danger' : 'pm-btn--primary'}`}
            disabled={!p || busy}
            onClick={() => void confirm()}
          >
            {busy ? 'Un momento…' : p?.mode === 'join' ? 'Sostituisci i dati di questo PC' : p?.mode === 'copy' ? 'Copia e usa la cartella' : 'Scrivi i dati e usa la cartella'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewText({ p }: { p: SharingFolderPreviewDto }) {
  const create = p.create && <li>La cartella non esiste ancora: verrà creata.</li>;
  if (p.mode === 'join') {
    return (
      <ul className="pm-folderconfirm__list">
        <li>
          La cartella contiene già i dati personali consegnati da <strong>{p.holderName ?? 'un altro PC'}</strong>
          {p.version != null && <> (versione {p.version}</>}
          {p.bytes > 0 && <>, {formatBytes(p.bytes)}</>}
          {p.version != null && ')'}.
        </li>
        <li>
          Collegandoti, <strong>progetti, task, note, regole e contatti di questo PC verranno sostituiti</strong> da quelli della cartella. La posta resta
          e si risistema nei progetti dell'altro PC.
        </li>
      </ul>
    );
  }
  if (p.mode === 'copy') {
    return (
      <ul className="pm-folderconfirm__list">
        {create}
        <li>
          Verrà copiato il contenuto della cartella attuale: <strong>{formatBytes(p.bytes)}</strong> in {p.files} file.
        </li>
        <li>
          La cartella attuale <code>{p.from}</code> non viene cancellata: eliminala tu quando anche l'altro PC usa quella nuova.
        </li>
      </ul>
    );
  }
  return (
    <ul className="pm-folderconfirm__list">
      {create}
      <li>
        Verranno scritti i dati personali di questo PC (progetti, task, note, regole, contatti, stato delle conversazioni): <strong>{formatBytes(p.dataBytes)}</strong>
        {p.files > 0 ? (
          <>
            , più {p.files} file caricati da te ({formatBytes(p.bytes - p.dataBytes)}): <strong>{formatBytes(p.bytes)}</strong> in tutto.
          </>
        ) : (
          '.'
        )}
      </li>
      <li>A ogni consegna il file dei dati si rinnova; si tengono le ultime tre versioni (fino a circa {formatBytes(p.dataBytes * 3)}).</li>
      <li>La posta non viene copiata: ogni PC la scarica da Gmail. Per ora il file dei dati non è cifrato.</li>
    </ul>
  );
}
