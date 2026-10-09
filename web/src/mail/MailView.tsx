import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import type { MessageDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS } from '../shell/paths.ts';
import type { ComposeRequest } from '../workspace/pane.ts';
import { CompactMessage, MessageCard } from './MessageCard.tsx';
import { DraftCard, type SentInfo } from './DraftCard.tsx';
import { composeTarget, NEW_DRAFT, seedOf, type DraftSeed } from './seed.ts';

const time = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const WHEEL_STEP = 60;
const WHEEL_COOLDOWN = 380;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/** Elemento scorrevole tra il bersaglio della rotella e la traccia: se può ancora scorrere, la rotella è sua. */
function canScroll(from: EventTarget | null, stop: HTMLElement, dy: number): boolean {
  for (let el = from instanceof HTMLElement ? from : null; el && el !== stop; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (!/(auto|scroll)/.test(style.overflowY) && el.tagName !== 'TEXTAREA') continue;
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
  }
  return false;
}

/**
 * S2/S3 · Email: carosello verticale sull'intera conversazione (D10, D11).
 * Lettura e scrittura sono la stessa schermata: la bozza è l'ultimo elemento.
 */
export function MailView({ projectKey, conversationId, messageId, draftId }: {
  projectKey: string;
  conversationId: string | null;
  messageId: string | null;
  draftId: string | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const stateSeed = (location.state as { seed?: DraftSeed } | null)?.seed;
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const conv = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.conversation(conversationId!), enabled: !!conversationId });
  const drafts = useQuery({ queryKey: ['drafts', conversationId], queryFn: () => api.conversationDrafts(conversationId!), enabled: !!conversationId });
  const d = conv.data ?? null;
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const wheel = useRef({ acc: 0, until: 0 });

  const messages: MessageDto[] = useMemo(() => [...(d?.messages ?? [])].sort((a, b) => a.date - b.date), [d]);
  const saved = drafts.data?.[0] ?? null;
  const n = messages.length;
  // Posizione nel carosello: un messaggio, oppure la bozza in fondo (indice n).
  const focus = draftId ? n : Math.max(0, messages.findIndex((m) => m.id === messageId));
  const projectName = projectKey === SYSTEM_INBOX ? 'Da smistare' : projectKey === SYSTEM_NEWS ? 'News' : (projects.find((p) => p.id === projectKey)?.name ?? '');

  // Seme di una bozza nuova: dalla navigazione, altrimenti "Rispondi a tutti" all'ultimo messaggio.
  const last = messages[n - 1];
  const seed: DraftSeed = useMemo(
    () => stateSeed ?? (last ? { replyToMessageId: last.id, replyAll: true, projectId: d?.projectId ?? null } : { projectId: projectKey }),
    [stateSeed, last, d?.projectId, projectKey],
  );

  // Una bozza alla volta per conversazione: chi chiede una risposta nuova ritrova quella salvata.
  useEffect(() => {
    if (conversationId && draftId === NEW_DRAFT && saved && !stateSeed?.forwardMessageId) {
      navigate(paths.draft(projectKey, conversationId, saved.id), { replace: true });
    }
  }, [conversationId, draftId, saved, stateSeed, projectKey, navigate]);

  // Posizione "viva": tasti premuti in rapida successione partono dall'ultima richiesta, non dall'ultimo render.
  const pos = useRef(focus);
  useEffect(() => {
    pos.current = focus;
  }, [focus]);
  const goTo = useCallback(
    (i: number) => {
      if (!conversationId) return;
      const target = Math.max(0, Math.min(n, i));
      if (target === pos.current) return;
      pos.current = target;
      if (target < n) navigate(paths.message(projectKey, conversationId, messages[target]!.id), { replace: true });
      else navigate(paths.draft(projectKey, conversationId, saved?.id ?? NEW_DRAFT), { replace: true });
    },
    [conversationId, n, navigate, projectKey, messages, saved],
  );

  const backToConversation = useCallback(() => {
    if (conversationId) navigate(paths.conversation(projectKey, conversationId));
    else navigate(paths.project(projectKey));
  }, [conversationId, navigate, projectKey]);

  const compose = useCallback(
    (r: ComposeRequest) => navigate(composeTarget(projectKey, r), { state: { seed: seedOf(r) }, replace: !!conversationId && !r.forward }),
    [navigate, projectKey, conversationId],
  );

  // Tastiera (§2.3 regola 8): j/k o frecce scorrono, r risponde, Esc torna alla conversazione.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        goTo(pos.current + 1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        goTo(pos.current - 1);
      } else if (e.key === 'r' && focus < n) {
        e.preventDefault();
        compose({ conversationId, replyTo: messages[focus], replyAll: true, projectId: d?.projectId ?? null });
      } else if (e.key === 'Escape') {
        backToConversation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, focus, n, compose, conversationId, messages, d?.projectId, backToConversation]);

  // Rotella: dentro la scheda in focus scorre il contenuto; ai bordi passa al messaggio vicino.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (canScroll(e.target, el, e.deltaY)) return;
      e.preventDefault();
      const w = wheel.current;
      const now = performance.now();
      if (now < w.until) return;
      w.acc += e.deltaY;
      if (Math.abs(w.acc) >= WHEEL_STEP) {
        goTo(pos.current + Math.sign(w.acc));
        w.acc = 0;
        w.until = now + WHEEL_COOLDOWN;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [goTo, focus]);

  const onSent = (info: SentInfo) => navigate(paths.conversation(info.projectId, info.conversationId));
  // La scheda resta montata quando è lei stessa a creare la bozza (new → id); per ogni altra bozza si rimonta.
  const created = useRef<{ id: string; key: string } | null>(null);
  const cardKey = draftId && created.current?.id === draftId ? created.current.key : (draftId ?? '');
  const onCreated = (id: string) => {
    created.current = { id, key: cardKey };
    if (conversationId) navigate(paths.draft(projectKey, conversationId, id), { replace: true, state: location.state });
    else navigate(paths.newMail(projectKey, id), { replace: true, state: location.state });
  };
  const draftKind = draftId ? ((draftId === NEW_DRAFT ? seed : saved && saved.id === draftId ? saved : seed).forwardMessageId ? 'Inoltro' : conversationId ? 'Nuova risposta' : 'Nuova mail') : null;

  if (conversationId && conv.isError) {
    return (
      <div className="pm-mailpage">
        <div className="pm-empty">Conversazione non trovata.</div>
      </div>
    );
  }

  const draftCard = draftId && (!conversationId || d) && (
    <DraftCard
      key={cardKey}
      draftId={draftId}
      seed={seed}
      d={d}
      onCreated={onCreated}
      onSaved={setSavedAt}
      onSent={onSent}
      onCancel={backToConversation}
    />
  );

  // Elementi visibili: bordo della pila, vicino compresso, elemento in focus, vicino compresso, bordo.
  const items: React.ReactNode[] = [];
  if (conversationId && d) {
    if (focus >= 2) items.push(<button type="button" key="edge-top" className="pm-msg-edge pm-msg-edge--top" aria-label="Messaggi precedenti" onClick={() => goTo(focus - 2)} />);
    if (focus >= 1) {
      const m = messages[focus - 1]!;
      items.push(<CompactMessage key={m.id} m={m} label={`Messaggio ${focus} di ${n}`} onClick={() => goTo(focus - 1)} />);
    }
    if (focus < n) {
      const m = messages[focus]!;
      items.push(<MessageCard key={m.id} m={m} d={d} index={focus} total={n} onCompose={compose} />);
      if (focus + 1 < n) {
        const next = messages[focus + 1]!;
        items.push(<CompactMessage key={next.id} m={next} label={`Messaggio ${focus + 2} di ${n}`} onClick={() => goTo(focus + 1)} />);
      } else if (saved) {
        items.push(
          <button type="button" key="draft-compact" className="pm-msg--compact" onClick={() => goTo(n)}>
            <span className="pm-msg__draftmark">Bozza</span>
            <span className="pm-msg__preview">{saved.body.replace(/\s+/g, ' ').trim() || saved.subject || '(vuota)'}</span>
            <span className="pm-msg__time">{shortDate(saved.updatedAt)}</span>
          </button>,
        );
      }
      if (focus + 2 < n || (focus + 2 === n && saved)) {
        items.push(<button type="button" key="edge-bottom" className="pm-msg-edge pm-msg-edge--bottom" aria-label="Messaggi successivi" onClick={() => goTo(focus + 2)} />);
      }
      if (focus === n - 1 && !saved) {
        items.push(
          <p key="hint" className="pm-carousel__hint">
            <Ic icon={ChevronDown} size={15} /> Scorri oltre l'ultimo messaggio per scrivere una risposta
          </p>,
        );
      }
    } else {
      items.push(<div key="draft" style={{ display: 'contents' }}>{draftCard}</div>);
    }
  } else if (!conversationId) {
    items.push(<div key="draft" style={{ display: 'contents' }}>{draftCard}</div>);
  }

  const position = draftId
    ? `${draftKind} · ${savedAt ? `bozza salvata alle ${time.format(new Date(savedAt))}` : 'non ancora salvata'}`
    : n
      ? `Messaggio ${focus + 1} di ${n}`
      : '';

  return (
    <div className="pm-mailpage">
      <div className="pm-contextbar">
        <button type="button" className="pm-btn pm-btn--secondary pm-contextbar__back" onClick={backToConversation}>
          <Ic icon={ArrowLeft} size={17} /> {conversationId ? 'Torna alla conversazione' : 'Torna al progetto'}
        </button>
        <span className="pm-contextbar__path">
          {projectName}
          {d && <> › {d.subject || '(nessun oggetto)'}</>}
        </span>
        <span className="pm-contextbar__pos" aria-live="polite">{position}</span>
        {conversationId && (
          <span className="pm-contextbar__nav">
            <button type="button" className="pm-squarebtn" aria-label="Messaggio precedente" disabled={focus === 0} onClick={() => goTo(focus - 1)}>
              <Ic icon={ChevronUp} />
            </button>
            <button type="button" className="pm-squarebtn" aria-label="Messaggio successivo" disabled={focus >= n} onClick={() => goTo(focus + 1)}>
              <Ic icon={ChevronDown} />
            </button>
          </span>
        )}
      </div>
      <div className="pm-mailview">
        <main className="pm-carousel">
          {conversationId && n > 0 && (
            <nav className="pm-minimap" aria-label="Posizione nella conversazione">
              {messages.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  className={`pm-minimap__dot${m.important && i !== focus ? ' pm-minimap__dot--important' : ''}`}
                  aria-current={i === focus ? 'true' : undefined}
                  aria-label={`Messaggio ${i + 1}${i === focus ? ', aperto' : ''}`}
                  onClick={() => goTo(i)}
                />
              ))}
              {focus === n ? (
                <span className="pm-minimap__dot" aria-current="true" aria-label={`${draftKind}, aperta`} />
              ) : (
                <button type="button" className="pm-minimap__new" aria-label={saved ? 'Apri la bozza' : 'Scrivi una risposta'} onClick={() => goTo(n)}>
                  <Ic icon={Plus} size={12} />
                </button>
              )}
            </nav>
          )}
          <div className="pm-carousel__track" ref={track} role="feed" aria-busy={conv.isLoading}>
            {conversationId && conv.isLoading && <div className="pm-empty">Caricamento…</div>}
            {items}
          </div>
        </main>
      </div>
    </div>
  );
}
