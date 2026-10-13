import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronLeft, Eraser, Sparkles, StickyNote, X } from 'lucide-react';
import type { AssistantMessageDto } from '@mmw/shared';
import { api, type AssistantAction } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useToast } from '../ui/toast.tsx';
import { PersonAvatar, useMe } from '../ui/People.tsx';

/** Pezzo di bozza selezionato, fotografato quando si chiede il ritocco. */
export interface DraftSelection {
  from: number;
  to: number;
  text: string;
}

/** Ciò che l'assistente può fare sulla bozza aperta nel carosello. */
export interface DraftHandle {
  body: () => string;
  insert: (text: string) => void;
  /** Il testo selezionato nella bozza (null se non c'è selezione). */
  selection: () => DraftSelection | null;
  /** Sostituisce quel pezzo; false se nel frattempo la bozza è cambiata lì. */
  replace: (sel: DraftSelection, text: string) => boolean;
}

/** La bozza avvisa l'assistente quando cambia la selezione (per mostrare su cosa agiscono i ritocchi). */
export const DRAFT_SELECTION_EVENT = 'mmw:draft-selection';

const READ_ACTIONS: { action: AssistantAction; label: string }[] = [
  { action: 'summarize', label: 'Riassumi la conversazione' },
  { action: 'needs_reply', label: 'Cosa richiede risposta?' },
  { action: 'extract_tasks', label: 'Estrai task' },
  { action: 'translate', label: 'Traduci' },
];

/**
 * Il modello riscrive un pezzo di frase come se fosse una frase intera (maiuscola, punto finale):
 * la proposta si adatta al pezzo che sostituisce.
 */
export function fitFragment(original: string, proposal: string): string {
  let out = proposal.trim().replace(/^["«“]|["»”]$/g, '');
  const o = original.trim();
  if (!/[.!?…]$/.test(o)) out = out.replace(/[.!…]+$/, '');
  if (/^\p{Ll}/u.test(o) && /^\p{Lu}\p{Ll}/u.test(out)) out = out[0]!.toLowerCase() + out.slice(1);
  return out;
}

const COLLAPSED_KEY = 'mmw.assistant.collapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

interface Pending {
  question: string;
  mode: 'read' | 'compose';
  answer: string;
  error?: string;
}

/**
 * Colonna Assistente (D12, UI v2): intestazione grigia, chat bianca, fascia grigia in basso con il campo
 * e, sotto, i suggerimenti (azioni rapide in lettura, "Come potresti rispondere" in scrittura).
 * La modalità segue l'elemento in focus; la chat è una per conversazione (o per bozza di nuova mail).
 * I ritocchi (più formale, più breve…) si chiedono scrivendo: agiscono sulla selezione, se c'è.
 */
export function Assistant({ conversationId, draftId, mode, messageId, context, draft }: {
  conversationId: string | null;
  draftId: string | null;
  mode: 'read' | 'compose';
  messageId: string | null;
  /** Sottotitolo: "sul messaggio 3 di 5", "legge questa conversazione"… */
  context: string;
  draft: React.RefObject<DraftHandle | null>;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const scope = { conversationId, draftId: conversationId ? null : draftId };
  const persisted = !!conversationId || (!!draftId && draftId !== 'new');
  const threadKey = ['assistant', conversationId ?? `draft:${draftId}`];
  const thread = useQuery({ queryKey: threadKey, queryFn: () => api.assistantThread(scope), enabled: persisted });
  const ideas = useQuery({
    queryKey: ['reply-ideas', conversationId],
    queryFn: () => api.replyIdeas(conversationId!),
    enabled: mode === 'compose' && !!conversationId,
    staleTime: Infinity,
    retry: false,
  });
  const questions = useQuery({
    queryKey: ['assistant-questions', conversationId],
    queryFn: () => api.suggestedQuestions(conversationId!),
    enabled: mode === 'read' && !!conversationId,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Testo selezionato nella bozza: i ritocchi agiscono su quello.
  const [draftSel, setDraftSel] = useState('');
  // Ultimo ritocco fatto su una selezione: la proposta può sostituirla al suo posto.
  const [replaceTarget, setReplaceTarget] = useState<DraftSelection | null>(null);
  useEffect(() => {
    const on = (e: Event) => setDraftSel((e as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener(DRAFT_SELECTION_EVENT, on);
    return () => window.removeEventListener(DRAFT_SELECTION_EVENT, on);
  }, []);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  // Chat di una nuova mail non ancora salvata: resta solo in pagina.
  const [local, setLocal] = useState<AssistantMessageDto[]>([]);
  const abort = useRef<AbortController | null>(null);
  const body = useRef<HTMLDivElement>(null);
  // Se la bozza viene salvata a chat iniziata, i messaggi locali restano in testa.
  const messages = persisted ? [...local, ...(thread.data ?? [])] : local;
  const lastProposal = [...messages].reverse().find((m) => m.role === 'assistant' && m.mode === 'compose');

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [messages.length, pending?.answer]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {}
  };

  const ask = async (question: string, opts: { action?: AssistantAction; mode?: 'read' | 'compose' } = {}) => {
    if (pending && !pending.error) return;
    const m = opts.mode ?? mode;
    // La selezione si fotografa adesso: è il pezzo che la proposta potrà sostituire.
    const sel = m === 'compose' ? (draft.current?.selection() ?? null) : null;
    setPending({ question, mode: m, answer: '' });
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const answer = await api.assistantChat(
        { ...scope, mode: m, messageId, draftBody: m === 'compose' ? draft.current?.body() : undefined, selection: sel?.text, action: opts.action, text: question },
        (piece) => setPending((p) => (p ? { ...p, answer: p.answer + piece } : p)),
        ctrl.signal,
      );
      if (m === 'compose') setReplaceTarget(sel);
      if (persisted) {
        await qc.invalidateQueries({ queryKey: threadKey });
      } else {
        const t = Date.now();
        setLocal((l) => [
          ...l,
          { id: `u${t}`, role: 'user', mode: m, content: question, createdAt: t },
          { id: `a${t}`, role: 'assistant', mode: m, content: answer.trim(), createdAt: t + 1 },
        ]);
      }
      setPending(null);
    } catch (e) {
      if (ctrl.signal.aborted) return setPending(null);
      setPending((p) => (p ? { ...p, error: (e as Error).message } : p));
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q) return;
    setText('');
    void ask(q);
  };

  const saveNote = async (content: string) => {
    if (!conversationId) return;
    try {
      await api.createNote(conversationId, content);
      qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      toast({ text: 'Salvata come nota della conversazione' });
    } catch (err) {
      toast({ text: (err as Error).message });
    }
  };
  const useAsSummary = async (content: string) => {
    if (!conversationId) return;
    try {
      await api.setSummary(conversationId, content);
      qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      toast({ text: 'Sintesi della conversazione aggiornata' });
    } catch (err) {
      toast({ text: (err as Error).message });
    }
  };
  const insert = (content: string) => {
    if (!draft.current) return toast({ text: 'Apri la bozza per inserire il testo' });
    draft.current.insert(content);
    toast({ text: 'Inserito nella bozza' });
  };
  const replaceSelection = (content: string) => {
    if (!draft.current || !replaceTarget) return insert(content);
    if (draft.current.replace(replaceTarget, fitFragment(replaceTarget.text, content))) {
      setReplaceTarget(null);
      toast({ text: 'Selezione sostituita' });
    } else {
      toast({ text: 'Quel pezzo della bozza è cambiato: usa Inserisci nella bozza' });
    }
  };
  const clear = async () => {
    if (persisted) {
      await api.clearAssistantThread(scope);
      qc.invalidateQueries({ queryKey: threadKey });
    } else setLocal([]);
  };

  if (collapsed) {
    return (
      <aside className="pm-assistant pm-assistant--collapsed" aria-label="Assistente">
        <button type="button" className="pm-assistant__logo" onClick={toggle} aria-label="Apri assistente" title="Apri assistente">
          <Ic icon={Sparkles} size={17} />
        </button>
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" onClick={toggle} aria-label="Apri assistente" style={{ marginTop: 8 }}>
          <Ic icon={ChevronLeft} />
        </button>
      </aside>
    );
  }

  const busy = !!pending && !pending.error;
  const bubbles = messages.map((m, i) =>
    m.role === 'user' ? (
      <UserBubble key={m.id} me={me}>{m.content}</UserBubble>
    ) : (
      <AiBubble
        key={m.id}
        m={m}
        canRephrase={m === lastProposal && i === messages.length - 1}
        onSaveNote={conversationId ? () => void saveNote(m.content) : undefined}
        onSummary={conversationId ? () => void useAsSummary(m.content) : undefined}
        onInsert={() => insert(m.content)}
        onReplace={m === lastProposal && replaceTarget ? () => replaceSelection(m.content) : undefined}
        onRephrase={() => void ask('Riformula', { action: 'rephrase', mode: 'compose' })}
        busy={busy}
      />
    ),
  );

  const suggestions =
    mode === 'read' ? (
      <>
        <div className="pm-assistant__section">Azioni rapide</div>
        <div className="pm-assistant__chips">
          {READ_ACTIONS.map((a) => (
            <button key={a.action} type="button" className="pm-quick" disabled={busy} onClick={() => void ask(a.label, { action: a.action })}>
              {a.label}
            </button>
          ))}
        </div>
        {conversationId && (questions.isLoading || (questions.data?.length ?? 0) > 0) && (
          <>
            <div className="pm-assistant__section pm-assistant__section--sugg">
              <Ic icon={Sparkles} size={13} /> Domande su questa conversazione
            </div>
            {questions.isLoading && <div className="pm-assistant__sub">Sto leggendo la conversazione…</div>}
            <div className="pm-assistant__chips">
              {questions.data?.map((q) => (
                <button key={q} type="button" className="pm-quick pm-quick--ai" disabled={busy} onClick={() => void ask(q)}>
                  {q}
                </button>
              ))}
            </div>
          </>
        )}
      </>
    ) : (
      conversationId && (
        <>
          <div className="pm-assistant__section pm-assistant__section--sugg">
            <Ic icon={Sparkles} size={13} /> Come potresti rispondere
          </div>
          {ideas.isLoading && <div className="pm-assistant__sub">Sto leggendo la conversazione…</div>}
          {ideas.isError && <div className="pm-assistant__sub">Suggerimenti non disponibili ({(ideas.error as Error).message}).</div>}
          {ideas.data?.length === 0 && <div className="pm-assistant__sub">Nessun suggerimento.</div>}
          {ideas.data?.map((idea) => (
            <button key={idea.title} type="button" className="pm-suggestion" disabled={busy} onClick={() => void ask(`${idea.title}: ${idea.description}`, { mode: 'compose' })}>
              <span className="pm-suggestion__title">{idea.title}</span>
              <span className="pm-suggestion__desc">{idea.description}</span>
            </button>
          ))}
        </>
      )
    );

  return (
    <aside className="pm-assistant" aria-label="Assistente">
      <div className="pm-assistant__head">
        <span className="pm-assistant__logo" aria-hidden="true">
          <Ic icon={Sparkles} size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pm-assistant__title">Assistente</div>
          <div className="pm-assistant__sub">Ollama · locale · {context}</div>
        </div>
        {messages.length > 0 && (
          <button type="button" className="pm-iconbtn pm-iconbtn--sm" onClick={() => void clear()} aria-label="Svuota la chat" title="Svuota la chat" disabled={busy}>
            <Ic icon={Eraser} />
          </button>
        )}
        <button type="button" className="pm-iconbtn pm-iconbtn--sm" onClick={toggle} aria-label="Riduci assistente" title="Riduci assistente">
          <Ic icon={X} size={16} />
        </button>
      </div>

      <div className="pm-assistant__chat" ref={body} role="log" aria-label="Chat con l'assistente" aria-live="polite">
        {thread.isLoading && persisted && <div className="pm-assistant__sub">Caricamento della chat…</div>}
        {!thread.isLoading && bubbles.length === 0 && !pending && (
          <div className="pm-assistant__empty">
            {mode === 'compose' ? 'Chiedi di scrivere, riformulare o correggere: se selezioni un pezzo della bozza, lavoro su quello.' : 'Chiedi qualcosa su questa conversazione, oppure usa un\'azione qui sotto.'}
          </div>
        )}
        {bubbles}
        {pending && (
          <>
            <UserBubble me={me}>{pending.question}</UserBubble>
            {pending.error ? (
              <AiRow>
                <div className="pm-bubble pm-bubble--ai pm-bubble--error" role="alert">{pending.error}</div>
              </AiRow>
            ) : (
              <AiRow>
                <div className="pm-bubble pm-bubble--ai">
                  <div className={pending.mode === 'compose' ? 'pm-bubble__quote' : undefined}>
                    {pending.answer}
                    <span className="pm-bubble__cursor" aria-hidden="true" />
                  </div>
                </div>
              </AiRow>
            )}
          </>
        )}
      </div>

      <form className="pm-assistant__foot" onSubmit={submit}>
        {mode === 'compose' && draftSel && (
          <div className="pm-assistant__selhint" title={draftSel}>
            Sulla selezione: «{draftSel.length > 60 ? `${draftSel.slice(0, 60)}…` : draftSel}»
          </div>
        )}
        <div className="pm-assistant__input">
          <textarea
            rows={2}
            aria-label="Chiedi all'assistente"
            placeholder={mode === 'compose' ? 'Chiedi all\'assistente…' : 'Chiedi qualcosa su questa conversazione…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button type="button" className="pm-assistant__send" onClick={() => abort.current?.abort()} aria-label="Interrompi la risposta" title="Interrompi">
              <span style={{ width: 10, height: 10, background: '#fff', borderRadius: 2 }} />
            </button>
          ) : (
            <button type="submit" className="pm-assistant__send" aria-label="Invia all'assistente" disabled={!text.trim()}>
              <Ic icon={ArrowUp} size={17} />
            </button>
          )}
        </div>
        {suggestions && <div className="pm-assistant__sugg">{suggestions}</div>}
      </form>
    </aside>
  );
}

/** Messaggio dell'utente: bolla azzurra con la bolla "Io" a destra. */
function UserBubble({ me, children }: { me: { name: string | null; email: string } | null; children: React.ReactNode }) {
  return (
    <div className="pm-chatrow pm-chatrow--user">
      <div className="pm-bubble pm-bubble--user">{children}</div>
      {me && <PersonAvatar person={me} size={26} />}
    </div>
  );
}

/** Risposta dell'assistente: icona lilla a sinistra. */
function AiRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="pm-chatrow">
      <span className="pm-who--ai" aria-hidden="true">
        <Ic icon={Sparkles} size={14} />
      </span>
      <div className="pm-chatrow__body">{children}</div>
    </div>
  );
}

function AiBubble({ m, canRephrase, onSaveNote, onSummary, onInsert, onReplace, onRephrase, busy }: {
  m: AssistantMessageDto;
  canRephrase: boolean;
  onSaveNote?: () => void;
  onSummary?: () => void;
  onInsert: () => void;
  /** Proposta nata da una selezione: la può sostituire al suo posto. */
  onReplace?: () => void;
  onRephrase: () => void;
  busy: boolean;
}) {
  if (m.mode === 'compose') {
    return (
      <AiRow>
      <div className="pm-bubble pm-bubble--ai">
        <div className="pm-bubble__quote">{m.content}</div>
        <div className="pm-bubble__actions">
          {onReplace && (
            <button type="button" className="pm-btn pm-assistant__primary pm-btn--xs" onClick={onReplace}>
              Sostituisci la selezione
            </button>
          )}
          <button type="button" className={`pm-btn ${onReplace ? 'pm-btn--secondary' : 'pm-assistant__primary'} pm-btn--xs`} onClick={onInsert}>
            Inserisci nella bozza
          </button>
          {canRephrase && (
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={onRephrase} disabled={busy}>
              Riformula
            </button>
          )}
        </div>
      </div>
      </AiRow>
    );
  }
  return (
    <AiRow>
      <div className="pm-bubble pm-bubble--ai">{m.content}</div>
      {(onSaveNote || onSummary) && (
        <div className="pm-bubble__actions">
          {onSaveNote && (
            <button type="button" className="pm-btn pm-assistant__primary pm-btn--xs" onClick={onSaveNote}>
              <Ic icon={StickyNote} size={15} /> Salva come nota
            </button>
          )}
          {onSummary && (
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={onSummary}>
              Usa come sintesi
            </button>
          )}
        </div>
      )}
    </AiRow>
  );
}
