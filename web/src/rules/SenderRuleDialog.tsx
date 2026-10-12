// "È / non è una News", "è / non è Spam": si sceglie a chi vale la regola (indirizzo o dominio), la
// conversazione si sposta e la regola vale per la posta futura. Poi si propone di applicarla anche alle
// conversazioni già arrivate dallo stesso mittente, con l'elenco da controllare prima di dire sì.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SenderRuleKind, SenderRuleResultDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { useToast } from '../ui/toast.tsx';

export const SENDER_RULE_EVENT = 'mmw:sender-rule';

/** Apre la finestra della regola per una conversazione (dal menu della conversazione). */
export function openSenderRule(conversationId: string, kind: SenderRuleKind) {
  window.dispatchEvent(new CustomEvent(SENDER_RULE_EVENT, { detail: { conversationId, kind } }));
}

const TEXT: Record<SenderRuleKind, { title: string; future: string; others: string; done: string }> = {
  news: { title: 'È una News', future: 'andranno nelle News', others: 'portarle nelle News', done: 'Spostata nelle News' },
  not_news: { title: 'Non è una News', future: 'resteranno fuori dalle News', others: 'toglierle dalle News', done: 'Tolta dalle News' },
  spam: { title: 'È spam', future: 'andranno nello Spam', others: 'portarle nello Spam', done: 'Segnalata come spam: va anche nella cartella Spam di Gmail' },
  not_spam: { title: 'Non è spam', future: 'resteranno fuori dallo Spam', others: 'toglierle dallo Spam', done: 'Tolta dallo Spam' },
};

/** Montato una volta nell'app: ascolta le richieste e mostra la finestra. */
export function SenderRuleHost() {
  const [req, setReq] = useState<{ conversationId: string; kind: SenderRuleKind } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<{ conversationId: string; kind: SenderRuleKind }>).detail);
    window.addEventListener(SENDER_RULE_EVENT, on);
    return () => window.removeEventListener(SENDER_RULE_EVENT, on);
  }, []);
  if (!req) return null;
  return <SenderRuleDialog key={`${req.conversationId}-${req.kind}`} {...req} onClose={() => setReq(null)} />;
}

function SenderRuleDialog({ conversationId, kind, onClose }: { conversationId: string; kind: SenderRuleKind; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = TEXT[kind];
  const { data: d } = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.conversation(conversationId) });
  const sender = d?.messages.find((m) => m.direction === 'in' && m.from)?.from?.email.toLowerCase() ?? null;
  const domain = sender ? sender.slice(sender.lastIndexOf('@')) : null;
  const root = domain ? `@${domain.slice(1).split('.').slice(-2).join('.')}` : null;
  const [scope, setScope] = useState<'address' | 'domain' | 'root'>('address');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SenderRuleResultDto | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = () => {
    for (const k of [['conversations'], ['counts'], ['projects'], ['activities'], ['conversation', conversationId]]) qc.invalidateQueries({ queryKey: k });
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.senderRule(conversationId, kind, scope);
      refresh();
      toast({ text: t.done });
      if (r.total === 0) onClose();
      else setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const applyToOthers = async () => {
    if (!result) return;
    setBusy(true);
    try {
      // L'anteprima ne mostra al massimo 200: per applicarla a tutte si chiede di nuovo l'elenco completo.
      const ids = result.items.map((i) => i.conversationId);
      const r = await api.applySenderRule(result.ruleId, ids);
      refresh();
      toast({ text: `Regola applicata ad altre ${r.applied} conversazioni` });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const options: { value: 'address' | 'domain' | 'root'; label: string }[] = sender
    ? [
        { value: 'address', label: sender },
        { value: 'domain', label: `tutto il dominio ${domain}` },
        ...(root && root !== domain ? [{ value: 'root' as const, label: `tutto ${root} (anche i sottodomini)` }] : []),
      ]
    : [];

  return (
    <div className="pm-modal" onClick={onClose}>
      <div className="pm-modal__card pm-rule" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t.title}>
        <h2 className="pm-modal__title">{t.title}</h2>
        {!result && (
          <>
            {!d && <p className="pm-muted">Caricamento…</p>}
            {d && !sender && <p className="pm-error">Questa conversazione non ha un mittente esterno: non si può creare una regola.</p>}
            {sender && (
              <>
                <p>
                  Questa conversazione e tutte le mail future di {options.length > 1 ? 'questo mittente' : sender} <strong>{t.future}</strong>.
                </p>
                <fieldset className="pm-rule__scope">
                  <legend className="pm-muted">La regola vale per</legend>
                  {options.map((o) => (
                    <label key={o.value}>
                      <input type="radio" name="scope" checked={scope === o.value} onChange={() => setScope(o.value)} /> {o.label}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {error && <div className="pm-error">{error}</div>}
            <div className="pm-inlineform__actions">
              <span style={{ flex: 1 }} />
              <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={onClose}>Annulla</button>
              <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" disabled={!sender || busy} onClick={() => void confirm()}>
                {t.title}
              </button>
            </div>
          </>
        )}
        {result && (
          <>
            <p>
              Fatto: la regola vale per le mail future di <strong>{result.pattern}</strong>.
            </p>
            <p>
              Si potrebbe applicare anche ad <strong>altre {result.total}</strong> {result.total === 1 ? 'conversazione' : 'conversazioni'} nella tua casella.
            </p>
            <button type="button" className="pm-rule__toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              <Ic icon={expanded ? ChevronDown : ChevronRight} size={15} /> {expanded ? 'Nascondi' : 'Mostra'} l'elenco
            </button>
            {expanded && (
              <ul className="pm-rule__list">
                {result.items.map((i) => (
                  <li key={i.conversationId}>
                    <span className="pm-truncate">{i.subject || '(senza oggetto)'}</span>
                    <span className="pm-muted pm-truncate">{i.from} · {shortDate(i.date)}</span>
                  </li>
                ))}
                {result.total > result.items.length && <li className="pm-muted">…e altre {result.total - result.items.length}</li>}
              </ul>
            )}
            <p className="pm-muted">Vuoi {t.others}{kind === 'spam' ? ' (solo nell\'app: su Gmail restano dove sono)' : ''}?</p>
            {error && <div className="pm-error">{error}</div>}
            <div className="pm-inlineform__actions">
              <span style={{ flex: 1 }} />
              <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={onClose}>No</button>
              <button type="button" className="pm-btn pm-btn--primary pm-btn--sm" disabled={busy} onClick={() => void applyToOthers()}>
                Sì, applica a {result.items.length === result.total ? 'tutte' : `queste ${result.items.length}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
