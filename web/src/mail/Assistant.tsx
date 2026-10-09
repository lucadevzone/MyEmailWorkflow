import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronLeft, ChevronRight, Eraser, Sparkles, StickyNote } from 'lucide-react';
import type { AssistantMessageDto } from '@mmw/shared';
import { api, type AssistantAction } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { useToast } from '../ui/toast.tsx';

/** Ciò che l'assistente può fare sulla bozza aperta nel carosello. */
export interface DraftHandle {
  body: () => string;
  insert: (text: string) => void;
}

const READ_ACTIONS: { action: AssistantAction; label: string }[] = [
  { action: 'summarize', label: 'Riassumi la conversazione' },
  { action: 'needs_reply', label: 'Cosa richiede risposta?' },
  { action: 'extract_tasks', label: 'Estrai task' },
  { action: 'translate', label: 'Traduci' },
];
const RETOUCHES: { action: AssistantAction; label: string }[] = [
  { action: 'formal', label: 'Più formale' },
  { action: 'shorter', label: 'Più breve' },
  { action: 'english', label: 'In inglese' },
  { action: 'fix', label: 'Correggi' },
];

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
 * Colonna Assistente (D12): sempre accanto al carosello. La modalità segue l'elemento in focus;
 * la chat è una per conversazione (o per bozza di nuova mail) e resta tra lettura e scrittura.
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
  const [collapsed, setCollapsed] = useState(readCollapsed);
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
    setPending({ question, mode: m, answer: '' });
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const answer = await api.assistantChat(
        { ...scope, mode: m, messageId, draftBody: m === 'compose' ? draft.current?.body() : undefined, action: opts.action, text: question },
        (piece) => setPending((p) => (p ? { ...p, answer: p.answer + piece } : p)),
        ctrl.signal,
      );
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
      <div key={m.id} className="pm-bubble pm-bubble--user">{m.content}</div>
    ) : (
      <AiBubble
        key={m.id}
        m={m}
        canRephrase={m === lastProposal && i === messages.length - 1}
        onSaveNote={conversationId ? () => void saveNote(m.content) : undefined}
        onSummary={conversationId ? () => void useAsSummary(m.content) : undefined}
        onInsert={() => insert(m.content)}
        onRephrase={() => void ask('Riformula', { action: 'rephrase', mode: 'compose' })}
        busy={busy}
      />
    ),
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
          <Ic icon={ChevronRight} />
        </button>
      </div>

      <div className="pm-assistant__body" ref={body} aria-live="polite">
        {mode === 'read' ? (
          <>
            <div className="pm-assistant__section">Azioni rapide</div>
            <div className="pm-assistant__chips">
              {READ_ACTIONS.map((a) => (
                <button key={a.action} type="button" className="pm-quick" disabled={busy} onClick={() => void ask(a.label, { action: a.action })}>
                  {a.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          conversationId && (
            <>
              <div className="pm-assistant__section">Come potresti rispondere</div>
              {ideas.isLoading && <div className="pm-assistant__sub">Sto leggendo la conversazione…</div>}
              {ideas.isError && <div className="pm-assistant__sub">Suggerimenti non disponibili ({(ideas.error as Error).message}).</div>}
              {ideas.data?.length === 0 && <div className="pm-assistant__sub">Nessun suggerimento.</div>}
              {ideas.data?.map((idea) => (
                <button
                  key={idea.title}
                  type="button"
                  className="pm-suggestion"
                  disabled={busy}
                  onClick={() => void ask(`${idea.title}: ${idea.description}`, { mode: 'compose' })}
                >
                  <span className="pm-suggestion__title">{idea.title}</span>
                  <span className="pm-suggestion__desc">{idea.description}</span>
                </button>
              ))}
            </>
          )
        )}
        {(bubbles.length > 0 || pending) && <div className="pm-assistant__sep" />}
        {thread.isLoading && persisted && <div className="pm-assistant__sub">Caricamento della chat…</div>}
        {bubbles}
        {pending && (
          <>
            <div className="pm-bubble pm-bubble--user">{pending.question}</div>
            {pending.error ? (
              <div className="pm-bubble pm-bubble--ai pm-bubble--error" role="alert">{pending.error}</div>
            ) : (
              <div className={`pm-bubble pm-bubble--ai`}>
                <div className={pending.mode === 'compose' ? 'pm-bubble__quote' : undefined}>
                  {pending.answer}
                  <span className="pm-bubble__cursor" aria-hidden="true" />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <form className="pm-assistant__foot" onSubmit={submit}>
        {mode === 'compose' && (
          <div className="pm-assistant__chips">
            {RETOUCHES.map((r) => (
              <button key={r.action} type="button" className="pm-quick" disabled={busy} onClick={() => void ask(r.label, { action: r.action, mode: 'compose' })}>
                {r.label}
              </button>
            ))}
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
      </form>
    </aside>
  );
}

function AiBubble({ m, canRephrase, onSaveNote, onSummary, onInsert, onRephrase, busy }: {
  m: AssistantMessageDto;
  canRephrase: boolean;
  onSaveNote?: () => void;
  onSummary?: () => void;
  onInsert: () => void;
  onRephrase: () => void;
  busy: boolean;
}) {
  if (m.mode === 'compose') {
    return (
      <div className="pm-bubble pm-bubble--ai">
        <div className="pm-bubble__quote">{m.content}</div>
        <div className="pm-bubble__actions">
          <button type="button" className="pm-btn pm-btn--primary pm-btn--xs" onClick={onInsert}>
            Inserisci nella bozza
          </button>
          {canRephrase && (
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={onRephrase} disabled={busy}>
              Riformula
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="pm-bubble pm-bubble--ai">
      {m.content}
      {(onSaveNote || onSummary) && (
        <div className="pm-bubble__actions">
          {onSaveNote && (
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={onSaveNote}>
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
    </div>
  );
}
