import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronUp, PenLine, Plus } from 'lucide-react';
import type { MessageDto } from '@mmw/shared';
import { api } from '../api.ts';
import { shortDate } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS, SYSTEM_SPAM } from '../shell/paths.ts';
import type { ComposeRequest } from '../workspace/pane.ts';
import { CompactMessage, MessageCard, PreviewMessage } from './MessageCard.tsx';
import { DraftCard, type SentInfo } from './DraftCard.tsx';
import { Assistant, type DraftHandle } from './Assistant.tsx';
import { composeTarget, NEW_DRAFT, seedOf, type DraftSeed } from './seed.ts';

const time = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });

/**
 * Linea di lettura: dove si ferma il bordo superiore della mail in focus, uguale per tutte (prima mail e
 * bozza comprese). 'peek': in alto, lasciando vedere l'intestazione del messaggio precedente;
 * 'top': a 16 px dal bordo; 'fraction': al 28% dell'altezza.
 */
const FOCUS_LINE = 'peek' as 'peek' | 'top' | 'fraction';
const READING_FRACTION = 0.28;
/** Quanto si vede del messaggio precedente: intestazione e una riga di testo. */
const PEEK = 64;
/** Riga compressa e spazio tra le schede (px). */
const COMPACT = 34;
const GAP = 6;
/** Tratto di scorrimento in cui un messaggio si apre mentre il precedente si chiude (px). */
const RAMP = 220;
/** Altezza stimata di una scheda non ancora misurata. */
const ESTIMATE = 420;
/** Altezza massima dell'anteprima dei messaggi vicini a quello in focus. */
const PREVIEW_MAX = 168;
/**
 * Sosta ("calamita"): tratto di scorrimento in cui la mail appena aperta resta ferma e piena,
 * prima che la colonna riprenda a scorrere. Dà resistenza all'uscita dal focus.
 */
const DWELL = 150;
/** Inizio del tratto in cui la colonna scorre dentro l'elemento: prima c'è l'apertura e poi la sosta. */
const HOLD = RAMP / 2 + DWELL;
/** Margine superiore del primo messaggio quando la conversazione parte dall'inizio. */
const TOP_MARGIN = 16;

/** Linea di lettura in px dal bordo superiore del carosello. */
const lineOf = (viewport: number) =>
  FOCUS_LINE === 'peek' ? TOP_MARGIN + PEEK + GAP : FOCUS_LINE === 'top' ? TOP_MARGIN : viewport * READING_FRACTION;

/** Il primo messaggio parte già allineato in alto: il suo tratto è più corto di questa quantità. */
const leadOf = (viewport: number) => (FOCUS_LINE === 'fraction' ? Math.max(0, lineOf(viewport) - TOP_MARGIN) : 0);

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
 * Spazio di scorrimento. Ogni messaggio ha: mezza rampa di apertura e la sosta (la colonna è ferma,
 * con il bordo superiore della mail sulla linea di lettura), poi un tratto lungo quanto la scheda
 * in cui la colonna scorre. L'ultimo elemento (la bozza) solo apertura ed eventuale eccedenza.
 */
function scrollLayout(full: number[], viewport: number): Layout {
  const starts: number[] = [];
  const lengths: number[] = [];
  let at = 0;
  full.forEach((h, i) => {
    const last = i === full.length - 1;
    const lead = i === 0 ? leadOf(viewport) : 0;
    const len = last ? RAMP / 2 + Math.max(RAMP / 2, overflowOf(h, viewport)) : HOLD + Math.max(1, h + GAP - lead);
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

/** Quanto l'ultimo elemento (la bozza) eccede lo spazio sotto la linea di lettura. */
const overflowOf = (h: number, viewport: number) => Math.max(0, h - (viewport - lineOf(viewport) - 16));

/**
 * Dissolvenze tra gli strati di un elemento (riga, anteprima, scheda piena). Le altezze cambiano in modo
 * graduale; lo scambio di strato avviene invece in un tratto breve, così non si vedono due strati insieme.
 * cardFade(o): opacità della scheda piena; con `out`, quanto deve sparire lo strato sotto (prima che compaia la scheda).
 */
const cardFade = (o: number, out = false) => (out ? smoothstep((o - 0.08) / 0.14) : smoothstep((o - 0.2) / 0.2));
/** Anteprima (1) o riga compressa (0) secondo la vicinanza. */
const nearFade = (near: number) => smoothstep((near - 0.42) / 0.16);

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
  // Conversazione aperta: la sua analisi mancante passa in primo piano (anche con l'analisi in pausa).
  useEffect(() => {
    if (conversationId) void api.analyzeConversation(conversationId).catch(() => {});
  }, [conversationId]);
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
  const projectName = projectKey === SYSTEM_INBOX ? 'Da smistare' : projectKey === SYSTEM_NEWS ? 'News' : projectKey === SYSTEM_SPAM ? 'Spam' : (projects.find((p) => p.id === projectKey)?.name ?? '');

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
      el.style.setProperty('--reading-line', String(lineOf(el.clientHeight) / Math.max(1, el.clientHeight)));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [conversationId]);

  // Altezza piena di ogni scheda (cambia, per esempio, quando l'HTML dell'email finisce di caricare).
  // L'osservatore vive in un effetto e, quando (ri)nasce, osserva tutti gli elementi già montati:
  // così resta attivo anche dopo il doppio montaggio di React in sviluppo.
  const observed = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      setMeasured((prev) => {
        let next = prev;
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const h = Math.round(el.offsetHeight);
          if (h && prev[el.dataset.key!] !== h) next = { ...next, [el.dataset.key!]: h };
        }
        return next;
      });
    });
    observer.current = ro;
    for (const el of observed.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, []);
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const cardRef = (key: string) => {
    let fn = refs.current.get(key);
    if (!fn) {
      fn = (el) => {
        const prev = observed.current.get(key);
        if (prev && prev !== el) observer.current?.unobserve(prev);
        if (el) {
          el.dataset.key = key;
          observed.current.set(key, el);
          observer.current?.observe(el);
        } else observed.current.delete(key);
      };
      refs.current.set(key, fn);
    }
    return fn;
  };

  /** Posizione di scorrimento in cui l'elemento i è aperto del tutto. */
  // Posizione di riposo: a metà della sosta (la bozza: appena aperta; il primo messaggio: all'inizio).
  const target = useCallback(
    (i: number) => (i === 0 ? 0 : i === L.starts.length - 1 ? L.starts[i]! + RAMP / 2 : L.starts[i]! + RAMP / 2 + DWELL / 2),
    [L],
  );
  const layoutRef = useRef(L);
  layoutRef.current = L;
  const targetRef = useRef(target);
  targetRef.current = target;
  // Elemento richiesto da un comando: a fine scorrimento si completa il movimento con le misure aggiornate
  // (aprendosi, la bozza cambia la geometria mentre lo scorrimento animato è in corso).
  const goal = useRef<number | null>(null);
  const goalAt = useRef(0);

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
      goal.current = k;
      goalAt.current = performance.now();
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ top: target(k), behavior: reduce ? 'auto' : 'smooth' });
    },
    [conversationId, n, target],
  );
  // Passo relativo: pressioni ravvicinate partono dalla meta già richiesta, non dal messaggio attuale.
  const step = useCallback((delta: number) => goTo((goal.current ?? pos.current) + delta), [goTo]);

  // Finché la meta di un comando non è raggiunta, ogni cambio di geometria (la bozza che si apre e si
  // misura, l'HTML che finisce di caricare) riporta lo scorrimento sulla posizione aggiornata.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || goal.current === null) return;
    if (performance.now() - goalAt.current > 4000) {
      goal.current = null;
      return;
    }
    if (indexAt(el.scrollTop, L) !== goal.current) return; // ancora in viaggio: ci pensa lo scorrimento in corso
    const t = target(goal.current);
    if (Math.abs(el.scrollTop - t) > 4) el.scrollTo({ top: t, behavior: 'smooth' });
  }, [L, target]);

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
      goal.current = null;
    };
    const settle = () => {
      if (goal.current === null) {
        // Calamita: fermandosi a metà di un passaggio tra due mail, ci si appoggia sulla più vicina.
        const Lc = layoutRef.current;
        const st = el.scrollTop;
        const last = Lc.starts.length - 1;
        for (let i = 0; i < last; i++) {
          const b = Lc.starts[i]! + Lc.lengths[i]!;
          if (st <= b - RAMP / 2 || st >= b + RAMP / 2) continue;
          const before = b - RAMP / 2; // mail i ancora piena, al suo fondo
          const after = b + RAMP / 2; // mail i+1 piena, inizio della sosta
          const to = st - before < after - st ? before : after;
          el.scrollTo({ top: to, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          break;
        }
        return;
      }
      const t = targetRef.current(goal.current);
      if (Math.abs(el.scrollTop - t) > 4) el.scrollTo({ top: t, behavior: 'smooth' });
      else goal.current = null;
    };
    el.addEventListener('scrollend', settle);
    const opts = { passive: true } as const;
    el.addEventListener('wheel', release, opts);
    el.addEventListener('touchstart', release, opts);
    el.addEventListener('pointerdown', release, opts);
    return () => {
      el.removeEventListener('wheel', release);
      el.removeEventListener('touchstart', release);
      el.removeEventListener('pointerdown', release);
      el.removeEventListener('scrollend', settle);
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
        step(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'r' && focus < n) {
        e.preventDefault();
        compose({ conversationId, replyTo: messages[focus], replyAll: true, projectId: d?.projectId ?? null });
      } else if (e.key === 'Escape') {
        backToConversation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, focus, n, compose, conversationId, messages, d?.projectId, backToConversation]);

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
    // Vicinanza: i messaggi accanto a quello in lettura sono anteprime, i più lontani righe compresse.
    // Si calcola sulla posizione frazionaria (indice + avanzamento), così anche questo passaggio è graduale.
    // Posizione continua "in indici": vale k a riposo sull'elemento k e k ± 0,5 ai suoi confini.
    const kp = indexAt(s, L);
    const up0 = s - L.starts[kp]!;
    const rest = target(kp) - L.starts[kp]!;
    const phase = up0 < rest ? -0.5 * ((rest - up0) / Math.max(1, rest)) : 0.5 * ((up0 - rest) / Math.max(1, L.lengths[kp]! - rest));
    // Oltre l'ultimo elemento (la bozza resta ferma mentre si continua a scorrere) la posizione non avanza:
    // altrimenti i messaggi sopra si comporterebbero come se ce ne fosse un altro dopo.
    const pr = kp + (kp === keys.length - 1 ? Math.min(0, phase) : phase);
    const near = keys.map((_, i) => 1 - smoothstep((Math.abs(i - pr) - 1.25) / 0.5));
    // Le anteprime sopra la mail in lettura si riducono all'intestazione e a una riga (quel che si vede
    // sopra la linea di lettura); il passaggio è graduale mentre il messaggio sale oltre il focus.
    const previewH = keys.map((k, i) => {
      if (i === n) return COMPACT;
      const fullPreview = Math.min(PREVIEW_MAX, Math.max(COMPACT, measured[`v:${k}`] ?? PREVIEW_MAX));
      if (FOCUS_LINE !== 'peek') return fullPreview;
      const above = smoothstep((pr - i - 0.5) / 0.5);
      return fullPreview + (Math.min(fullPreview, PEEK) - fullPreview) * above;
    });
    const heights = full.map((h, i) => {
      const base = COMPACT + (previewH[i]! - COMPACT) * near[i]!;
      return base + (Math.max(h, base) - base) * open[i]!;
    });
    const tops: number[] = [];
    heights.reduce((y, h) => {
      tops.push(y);
      return y + h + GAP;
    }, 0);
    // Punto della colonna che sta sulla linea di lettura: avanza dentro l'elemento corrente con lo scorrimento.
    const k = indexAt(s, L);
    const lastIdx = keys.length - 1;
    const u = s - L.starts[k]!;
    const lead = k === 0 ? Math.min(leadOf(viewport), heights[0]! + GAP) : 0;
    let local: number;
    if (k === lastIdx) {
      local = Math.min(Math.max(0, u - RAMP / 2), overflowOf(heights[k]!, viewport));
    } else {
      // Fermo durante apertura e sosta; poi la colonna scorre dentro la mail fino al suo fondo.
      const travel = Math.max(1, L.lengths[k]! - HOLD);
      const t = Math.min(travel, Math.max(0, u - HOLD));
      local = lead + (t / travel) * (heights[k]! + GAP - lead);
    }
    const lineY = lineOf(viewport);
    let shift = lineY - (tops[k]! + local);
    // Con la bozza aperta la colonna non sale oltre il suo fondo: resta ferma sul bordo inferiore.
    // La regola entra in proporzione all'apertura della bozza, così non ci sono salti.
    const contentBottom = tops[lastIdx]! + heights[lastIdx]!;
    const pinnedShift = Math.max(shift, Math.min(lineY, viewport - 16 - contentBottom));
    shift += (pinnedShift - shift) * open[lastIdx]!;

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
                    opacity: cardFade(o),
                    clipPath: o < 1 ? `inset(${-offset}px 0 ${full[i]! - h + offset}px 0 round 18px)` : undefined,
                  }}
                  inert={o < 0.5}
                >
                  <div ref={cardRef(key)}>
                    {isDraft ? draftCard : <MessageCard m={messages[i]!} d={d} index={i} total={n} onCompose={compose} active={i === focus} />}
                  </div>
                </div>
              )}
              {/* sempre presente (anche invisibile) per misurarne l'altezza prima che serva */}
              {o < 1 && !isDraft && (
                <div
                  className="pm-carousel__preview"
                  style={{
                    opacity: nearFade(near[i]!) * (1 - cardFade(o, true)),
                    // ritagliata all'altezza dell'elemento: non sborda mai sotto la mail successiva
                    clipPath: `inset(0 0 ${Math.max(0, (measured[`v:${key}`] ?? PREVIEW_MAX) - h)}px 0 round 14px)`,
                  }}
                  inert={o >= 0.5 || near[i]! < 0.5}
                >
                  <div ref={cardRef(`v:${key}`)} className="pm-carousel__previewbox">
                    <PreviewMessage m={messages[i]!} label={`Messaggio ${i + 1} di ${n}`} onClick={() => goTo(i)} />
                  </div>
                </div>
              )}
              {o < 1 && (isDraft || near[i]! < 1) && (
                <div
                  className="pm-carousel__row"
                  style={{ opacity: (hasCard ? 1 - cardFade(o, true) : 1) * (isDraft ? 1 : 1 - nearFade(near[i]!)) }}
                  inert={(hasCard && o >= 0.5) || (!isDraft && near[i]! >= 0.5)}
                >
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
        <button
          type="button"
          className="pm-btn pm-btn--secondary pm-contextbar__back"
          onClick={backToConversation}
          aria-label={conversationId ? 'Torna alla conversazione' : 'Torna al progetto'}
        >
          <Ic icon={ArrowLeft} size={17} />
          <span className="pm-contextbar__backtext">{conversationId ? 'Torna alla conversazione' : 'Torna al progetto'}</span>
        </button>
        <span className="pm-contextbar__path">
          {projectName}
          {d && <> › {d.subject || '(nessun oggetto)'}</>}
        </span>
        <span className="pm-contextbar__pos" aria-live="polite">{position}</span>
        {conversationId && (
          <span className="pm-contextbar__nav">
            <button type="button" className="pm-squarebtn" aria-label="Messaggio precedente" disabled={focus === 0} onClick={() => step(-1)}>
              <Ic icon={ChevronUp} />
            </button>
            <button type="button" className="pm-squarebtn" aria-label="Messaggio successivo" disabled={focus >= n} onClick={() => step(1)}>
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
