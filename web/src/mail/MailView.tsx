import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronUp, PenLine, Plus } from 'lucide-react';
import type { MessageDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS } from '../shell/paths.ts';
import type { ComposeRequest } from '../workspace/pane.ts';
import { CompactMessage, MessageCard } from './MessageCard.tsx';
import { DraftCard, type SentInfo } from './DraftCard.tsx';
import { Assistant, type DraftHandle } from './Assistant.tsx';
import { composeTarget, NEW_DRAFT, seedOf, type DraftSeed } from './seed.ts';

const time = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
/** Linea di lettura (frazione dell'altezza visibile): il messaggio che la attraversa è quello in focus. */
const READING_LINE = 0.2;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SWAP_MS = 260;

/** Fotografia della scheda in focus prima del cambio: una copia statica (gli iframe diventano riquadri bianchi). */
function snapshot(root: HTMLElement | null, idx: number, dir: 'down' | 'up') {
  const card = root?.querySelector<HTMLElement>(`[data-idx="${idx}"] > :first-child`);
  if (!card || reducedMotion()) return null;
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('iframe').forEach((f) => {
    const box = document.createElement('div');
    box.style.cssText = `height:${f.getBoundingClientRect().height}px;background:#fff`;
    f.replaceWith(box);
  });
  return { idx, clone, rect: card.getBoundingClientRect(), dir };
}

/** Passaggio di focus: la vecchia scheda si richiude sulla sua riga, la nuova si apre dal bordo da cui entra. */
function animateSwap(root: HTMLElement, from: NonNullable<ReturnType<typeof snapshot>>, newItem: HTMLElement) {
  const box = root.getBoundingClientRect();
  const at = (r: DOMRect) => ({ top: `${r.top - box.top + root.scrollTop}px`, left: `${r.left - box.left + root.scrollLeft}px`, width: `${r.width}px`, height: `${r.height}px` });
  const row = root.querySelector<HTMLElement>(`[data-idx="${from.idx}"] > :first-child`);
  const ghost = from.clone;
  Object.assign(ghost.style, { position: 'absolute', margin: '0', zIndex: '2', pointerEvents: 'none', overflow: 'hidden', boxSizing: 'border-box', ...at(from.rect) });
  ghost.setAttribute('aria-hidden', 'true');
  root.appendChild(ghost);
  const end = row ? at(row.getBoundingClientRect()) : { ...at(from.rect), height: '34px' };
  ghost
    .animate([{ ...at(from.rect), opacity: 1 }, { ...end, opacity: 0 }], { duration: SWAP_MS, easing: 'cubic-bezier(.4,0,.2,1)' })
    .finished.catch(() => {})
    .finally(() => ghost.remove());
  // Se la pagina non disegna (finestra nascosta) l'animazione resta ferma: la copia va tolta comunque.
  window.setTimeout(() => ghost.remove(), SWAP_MS + 150);

  const card = newItem.firstElementChild as HTMLElement | null;
  const closed = from.dir === 'down' ? 'inset(0 0 calc(100% - 34px) 0 round 18px)' : 'inset(calc(100% - 34px) 0 0 0 round 18px)';
  card?.animate([{ clipPath: closed, opacity: 0.5 }, { clipPath: 'inset(0 0 0 0 round 18px)', opacity: 1 }], { duration: SWAP_MS, easing: 'cubic-bezier(.4,0,.2,1)' });
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

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
  const carousel = useRef<HTMLElement>(null);
  // Cambio di focus dallo scorrimento: si tiene fermo l'elemento che entra in focus (le altezze cambiano sopra di lui).
  // Scendendo resta fermo il bordo superiore (si legge dall'alto), salendo quello inferiore (si legge risalendo).
  const anchor = useRef<{ idx: number; edge: 'top' | 'bottom'; y: number; at: number } | null>(null);
  // Cambio di focus da comando (tasti, frecce, mini-mappa, clic): si scorre fino all'elemento.
  const scrollTo = useRef<{ idx: number; smooth: boolean } | null>(null);
  // Durante uno scorrimento programmato il focus non segue la posizione.
  const quietUntil = useRef(0);
  // Copia della scheda che si chiude, per l'animazione di passaggio.
  const closing = useRef<{ idx: number; clone: HTMLElement; rect: DOMRect; dir: 'down' | 'up' } | null>(null);
  const draftHandle = useRef<DraftHandle | null>(null);

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
  const select = useCallback(
    (i: number, how: 'scroll' | 'command') => {
      if (!conversationId) return;
      const target = Math.max(0, Math.min(n, i));
      if (target === pos.current) return;
      closing.current = snapshot(carousel.current, pos.current, target > pos.current ? 'down' : 'up');
      if (how === 'scroll') {
        const el = carousel.current?.querySelector<HTMLElement>(`[data-idx="${target}"]`);
        const r = el?.getBoundingClientRect();
        const edge = target > pos.current ? 'top' : 'bottom';
        anchor.current = r ? { idx: target, edge, y: edge === 'top' ? r.top : r.bottom, at: performance.now() } : null;
      } else {
        scrollTo.current = { idx: target, smooth: true };
      }
      pos.current = target;
      if (target < n) navigate(paths.message(projectKey, conversationId, messages[target]!.id), { replace: true });
      else navigate(paths.draft(projectKey, conversationId, saved?.id ?? NEW_DRAFT), { replace: true });
    },
    [conversationId, n, navigate, projectKey, messages, saved],
  );
  const goTo = useCallback((i: number) => select(i, 'command'), [select]);

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

  // Scorrimento nativo e continuo: il focus passa all'elemento che attraversa la linea di lettura.
  useEffect(() => {
    const el = carousel.current;
    if (!el || !conversationId) return;
    // Pochi elementi da misurare: il calcolo si fa direttamente a ogni evento di scorrimento.
    const onScroll = () => {
      const now = performance.now();
      if (now < quietUntil.current) return;
      // Un cambio di focus è in corso: il layout misurato ora è quello vecchio.
      if (anchor.current && now - anchor.current.at < 400) return;
      const box = el.getBoundingClientRect();
      const line = box.top + box.height * READING_LINE;
      for (const item of el.querySelectorAll<HTMLElement>('[data-idx]')) {
        const r = item.getBoundingClientRect();
        if (r.top <= line && r.bottom > line) {
          select(Number(item.dataset.idx), 'scroll');
          break;
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [select, conversationId]);

  // Altezza visibile del carosello: da qui gli spazi sopra/sotto e l'altezza minima della scheda in focus (CSS).
  useLayoutEffect(() => {
    const el = carousel.current;
    if (!el) return;
    const apply = () => {
      el.style.setProperty('--carousel-h', `${el.clientHeight}px`);
      el.style.setProperty('--reading-line', String(READING_LINE));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Dopo il cambio di focus: compensa le altezze cambiate sopra, oppure porta l'elemento alla linea di lettura.
  const ready = !conversationId || !!d;
  const firstScroll = useRef(true);
  useLayoutEffect(() => {
    const el = carousel.current;
    if (!el || !ready) return;
    const item = el.querySelector<HTMLElement>(`[data-idx="${focus}"]`);
    if (!item) return;
    if (firstScroll.current) {
      firstScroll.current = false;
      scrollTo.current = { idx: focus, smooth: false };
    }
    if (anchor.current?.idx === focus) {
      const r = item.getBoundingClientRect();
      el.scrollTop += (anchor.current.edge === 'top' ? r.top : r.bottom) - anchor.current.y;
      anchor.current = null;
    } else if (scrollTo.current?.idx === focus) {
      const box = el.getBoundingClientRect();
      const delta = item.getBoundingClientRect().top - (box.top + box.height * READING_LINE) + 24;
      const smooth = scrollTo.current.smooth && !reducedMotion();
      quietUntil.current = performance.now() + (smooth ? 700 : 100);
      el.scrollTo({ top: el.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
      scrollTo.current = null;
    }
    if (closing.current) {
      animateSwap(el, closing.current, item);
      closing.current = null;
    }
  }, [focus, ready, draftId]);

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
      handle={draftHandle}
    />
  );

  // Tutta la conversazione in una colonna che scorre: in focus la scheda intera, gli altri compressi; in fondo la bozza.
  const items: React.ReactNode[] = [];
  if (conversationId && d) {
    messages.forEach((m, i) => {
      items.push(
        i === focus ? (
          <div key={m.id} data-idx={i} className="pm-carousel__item">
            <MessageCard m={m} d={d} index={i} total={n} onCompose={compose} />
          </div>
        ) : (
          <div key={m.id} data-idx={i} className="pm-carousel__item pm-carousel__item--compact">
            <CompactMessage m={m} label={`Messaggio ${i + 1} di ${n}`} onClick={() => goTo(i)} />
          </div>
        ),
      );
    });
    items.push(
      focus === n ? (
        <div key="draft" data-idx={n} className="pm-carousel__item">{draftCard}</div>
      ) : (
        <div key="draft" data-idx={n} className="pm-carousel__item pm-carousel__item--compact">
          {saved ? (
            <button type="button" className="pm-msg--compact" onClick={() => goTo(n)}>
              <span className="pm-msg__draftmark">Bozza</span>
              <span className="pm-msg__preview">{saved.body.replace(/\s+/g, ' ').trim() || saved.subject || '(vuota)'}</span>
              <span className="pm-msg__time">{shortDate(saved.updatedAt)}</span>
            </button>
          ) : (
            <button type="button" className="pm-msg--compact pm-msg--newreply" onClick={() => goTo(n)}>
              <Ic icon={PenLine} size={15} />
              <span className="pm-msg__preview">Scorri qui o fai clic per scrivere una risposta</span>
            </button>
          )}
        </div>
      ),
    );
  } else if (!conversationId) {
    items.push(<div key="draft" className="pm-carousel__item">{draftCard}</div>);
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
        <main className="pm-carousel" ref={carousel}>
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
          <div className={`pm-carousel__track${!conversationId ? ' pm-carousel__track--single' : focus === n ? ' pm-carousel__track--end' : ''}`} role="feed" aria-busy={conv.isLoading}>
            {conversationId && conv.isLoading && <div className="pm-empty">Caricamento…</div>}
            {items}
          </div>
        </main>
        <Assistant
          conversationId={conversationId}
          draftId={draftId}
          mode={draftId ? 'compose' : 'read'}
          messageId={draftId ? null : (messages[focus]?.id ?? null)}
          context={draftId ? (conversationId ? 'legge questa conversazione' : 'ti aiuta a scrivere') : `sul messaggio ${focus + 1} di ${n}`}
          draft={draftHandle}
        />
      </div>
    </div>
  );
}
