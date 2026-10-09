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
/** Riga compressa e spazio tra le schede (px). */
const COMPACT = 34;
const GAP = 6;
/** Tratto di scorrimento in cui un messaggio si apre mentre il precedente si chiude (px). */
const RAMP = 220;
/** Altezza stimata di una scheda non ancora misurata. */
const ESTIMATE = 420;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

interface Layout {
  /** Inizio del tratto di scorrimento di ogni elemento. */
  starts: number[];
  lengths: number[];
  total: number;
}

/**
 * Spazio di scorrimento: ogni elemento occupa un tratto lungo quanto la sua scheda piena;
 * l'ultimo solo quanto basta perché il suo fondo arrivi al bordo inferiore.
 */
function scrollLayout(full: number[], viewport: number): Layout {
  const starts: number[] = [];
  const lengths: number[] = [];
  let at = 0;
  full.forEach((h, i) => {
    const last = i === full.length - 1;
    const len = last ? Math.max(RAMP, h - viewport * (1 - READING_LINE) + RAMP) : Math.max(RAMP, h + GAP);
    starts.push(at);
    lengths.push(len);
    at += len;
  });
  return { starts, lengths, total: at };
}

/** Quanto è aperto l'elemento i alla posizione s: 0 = riga compressa, 1 = scheda piena. */
function openness(i: number, s: number, L: Layout): number {
  const a = L.starts[i]!;
  const b = a + L.lengths[i]!;
  const up = i === 0 ? 1 : smoothstep((s - (a - RAMP / 2)) / RAMP);
  const down = i === L.starts.length - 1 ? 1 : smoothstep((b + RAMP / 2 - s) / RAMP);
  return Math.min(up, down);
}

const indexAt = (s: number, L: Layout) => {
  const k = L.starts.findIndex((a, i) => s >= a && s < a + L.lengths[i]!);
  return k >= 0 ? k : s <= 0 ? 0 : L.starts.length - 1;
};

/**
 * S2/S3 · Email: carosello verticale sull'intera conversazione (D10, D11).
 * Lettura e scrittura sono la stessa schermata: la bozza è l'ultimo elemento.
 *
 * Lo scorrimento è continuo: ogni messaggio ha un suo tratto dello spazio di scorrimento e, in una
 * scena ferma (sticky), si apre e si chiude in proporzione alla posizione, senza soglie.
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
  const scroller = useRef<HTMLElement>(null);
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

  // ─── Geometria: altezza visibile, altezze piene misurate, posizione di scorrimento ───

  const [viewport, setViewport] = useState(600);
  const [s, setS] = useState(0);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const keys = useMemo(() => [...messages.map((m) => m.id), 'draft'], [messages]);
  // La riga "Bozza" / "scrivi una risposta" non ha una scheda finché la bozza non è aperta.
  const full = keys.map((k, i) => (i === n && focus !== n ? COMPACT : Math.max(COMPACT, measured[k] ?? ESTIMATE)));
  const fullKey = full.join(',');
  const L = useMemo(() => scrollLayout(full, viewport), [fullKey, viewport]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const apply = () => {
      setViewport(el.clientHeight);
      el.style.setProperty('--carousel-h', `${el.clientHeight}px`);
      el.style.setProperty('--reading-line', String(READING_LINE));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [conversationId]);

  // Altezza piena di ogni scheda (cambia, per esempio, quando l'HTML dell'email finisce di caricare).
  const observer = useMemo(
    () =>
      new ResizeObserver((entries) => {
        setMeasured((prev) => {
          let next = prev;
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const h = Math.round(el.offsetHeight);
            if (h && prev[el.dataset.key!] !== h) next = { ...next, [el.dataset.key!]: h };
          }
          return next;
        });
      }),
    [],
  );
  useEffect(() => () => observer.disconnect(), [observer]);
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const cardRef = (key: string) => {
    let fn = refs.current.get(key);
    if (!fn) {
      let current: HTMLElement | null = null;
      fn = (el) => {
        if (current) observer.unobserve(current);
        current = el;
        if (el) {
          el.dataset.key = key;
          observer.observe(el);
        }
      };
      refs.current.set(key, fn);
    }
    return fn;
  };

  /** Posizione di scorrimento in cui l'elemento i è aperto del tutto. */
  const target = useCallback((i: number) => L.starts[i]! + (i === 0 ? 0 : Math.min(RAMP / 2, L.lengths[i]! / 2)), [L]);

  // Elemento in focus = quello il cui tratto contiene la posizione; l'indirizzo lo segue.
  const pos = useRef(focus);
  useEffect(() => {
    pos.current = focus;
  }, [focus]);
  const select = useCallback(
    (i: number) => {
      if (!conversationId || i === pos.current) return;
      pos.current = i;
      scrolledTo.current = i;
      if (i < n) navigate(paths.message(projectKey, conversationId, messages[i]!.id), { replace: true });
      else navigate(paths.draft(projectKey, conversationId, saved?.id ?? NEW_DRAFT), { replace: true });
    },
    [conversationId, n, navigate, projectKey, messages, saved],
  );

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (placedAt.current === null || Math.abs(el.scrollTop - placedAt.current) > 2) pinned.current = false;
    setS(el.scrollTop);
    select(indexAt(el.scrollTop, L));
  };

  // Comandi (tasti, frecce, mini-mappa, clic): si scorre fino all'elemento; la transizione segue lo scorrimento.
  const goTo = useCallback(
    (i: number) => {
      const el = scroller.current;
      if (!el || !conversationId) return;
      const k = Math.max(0, Math.min(n, i));
      pinned.current = false;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ top: target(k), behavior: reduce ? 'auto' : 'smooth' });
    },
    [conversationId, n, target],
  );

  // All'apertura, e quando il focus cambia per un motivo esterno allo scorrimento (es. "Rispondi"), si va
  // all'elemento e ci si resta agganciati mentre le schede vengono misurate, finché l'utente non scorre.
  const pinned = useRef(true);
  // Posizione impostata dal codice: uno scorrimento che se ne allontana è dell'utente e sgancia.
  const placedAt = useRef<number | null>(null);
  // Ultimo focus deciso dallo scorrimento: un focus diverso arriva da fuori (link, "Rispondi"…).
  const scrolledTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !d) return;
    if (scrolledTo.current !== focus && indexAt(el.scrollTop, L) !== focus) pinned.current = true;
    if (pinned.current) {
      el.scrollTop = target(focus);
      placedAt.current = el.scrollTop;
      setS(el.scrollTop);
    }
  }, [d, focus, L]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const release = () => {
      pinned.current = false;
    };
    const opts = { passive: true } as const;
    el.addEventListener('wheel', release, opts);
    el.addEventListener('touchstart', release, opts);
    el.addEventListener('pointerdown', release, opts);
    return () => {
      el.removeEventListener('wheel', release);
      el.removeEventListener('touchstart', release);
      el.removeEventListener('pointerdown', release);
    };
  }, [conversationId]);

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

  // ─── Scena: ogni elemento alto in proporzione alla sua apertura; la colonna segue la linea di lettura ───

  let stage: React.ReactNode = null;
  if (conversationId && d) {
    const open = keys.map((_, i) => openness(i, s, L));
    const heights = full.map((h, i) => COMPACT + (h - COMPACT) * open[i]!);
    const tops: number[] = [];
    heights.reduce((y, h) => {
      tops.push(y);
      return y + h + GAP;
    }, 0);
    // Punto della colonna che sta sulla linea di lettura: avanza dentro l'elemento corrente con lo scorrimento.
    const k = indexAt(s, L);
    const lastIdx = keys.length - 1;
    const progress = Math.min(1, Math.max(0, (s - L.starts[k]!) / L.lengths[k]!));
    const local = k === lastIdx ? Math.min(progress * L.lengths[k]!, heights[k]!) : progress * (heights[k]! + GAP);
    const lineY = viewport * READING_LINE;
    let shift = lineY - (tops[k]! + local);
    // La colonna non sale oltre il fondo dell'ultimo elemento: resta ferma sul bordo inferiore.
    const contentBottom = tops[lastIdx]! + heights[lastIdx]!;
    shift = Math.max(shift, Math.min(lineY, viewport - 16 - contentBottom));

    stage = (
      <div className="pm-carousel__track" role="feed" style={{ transform: `translateY(${shift}px)` }}>
        {keys.map((key, i) => {
          const o = open[i]!;
          const h = heights[i]!;
          const isDraft = i === n;
          const hasCard = !isDraft || focus === n;
          // Aprendosi dal basso (salendo) si vede prima la fine della scheda, dall'alto l'inizio.
          const fromBottom = i !== lastIdx && s > L.starts[i]! + L.lengths[i]! / 2;
          const offset = fromBottom ? h - full[i]! : 0;
          return (
            <div key={key} className="pm-carousel__item" style={{ height: h }} data-idx={i}>
              {hasCard && (
                <div
                  className="pm-carousel__card"
                  style={{
                    transform: offset ? `translateY(${offset}px)` : undefined,
                    opacity: Math.min(1, o * 1.6),
                    clipPath: o < 1 ? `inset(${-offset}px 0 ${full[i]! - h + offset}px 0 round 18px)` : undefined,
                  }}
                  inert={o < 0.5}
                >
                  <div ref={cardRef(key)}>
                    {isDraft ? draftCard : <MessageCard m={messages[i]!} d={d} index={i} total={n} onCompose={compose} active={i === focus} />}
                  </div>
                </div>
              )}
              {o < 1 && (
                <div className="pm-carousel__row" style={{ opacity: hasCard ? Math.max(0, 1 - o * 2.5) : 1 }} inert={hasCard && o >= 0.5}>
                  {isDraft ? (
                    saved ? (
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
                    )
                  ) : (
                    <CompactMessage m={messages[i]!} label={`Messaggio ${i + 1} di ${n}`} onClick={() => goTo(i)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Contatore e mini-mappa seguono la posizione in diretta (l'indirizzo si aggiorna appena lo scorrimento rallenta).
  const live = conversationId && d ? indexAt(s, L) : focus;
  const position = live === n && draftId
    ? `${draftKind} · ${savedAt ? `bozza salvata alle ${time.format(new Date(savedAt))}` : 'non ancora salvata'}`
    : n && live < n
      ? `Messaggio ${live + 1} di ${n}`
      : n ? 'Nuova risposta' : '';

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
        {conversationId ? (
          <main className="pm-carousel" ref={scroller} onScroll={onScroll}>
            <div className="pm-carousel__stage">
              {n > 0 && (
                <nav className="pm-minimap" aria-label="Posizione nella conversazione">
                  {messages.map((m, i) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`pm-minimap__dot${m.important && i !== live ? ' pm-minimap__dot--important' : ''}`}
                      aria-current={i === live ? 'true' : undefined}
                      aria-label={`Messaggio ${i + 1}${i === live ? ', aperto' : ''}`}
                      onClick={() => goTo(i)}
                    />
                  ))}
                  {live === n ? (
                    <span className="pm-minimap__dot" aria-current="true" aria-label={`${draftKind}, aperta`} />
                  ) : (
                    <button type="button" className="pm-minimap__new" aria-label={saved ? 'Apri la bozza' : 'Scrivi una risposta'} onClick={() => goTo(n)}>
                      <Ic icon={Plus} size={12} />
                    </button>
                  )}
                </nav>
              )}
              <div className="pm-carousel__column">
                {conv.isLoading && <div className="pm-empty">Caricamento…</div>}
                {stage}
              </div>
            </div>
            {/* Spazio di scorrimento: la scena resta ferma, la posizione decide cosa mostrare. */}
            <div aria-hidden="true" style={{ height: L.total }} />
          </main>
        ) : (
          <main className="pm-carousel pm-carousel--single" ref={scroller}>
            <div className="pm-carousel__track pm-carousel__track--single">{draftCard}</div>
          </main>
        )}
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
