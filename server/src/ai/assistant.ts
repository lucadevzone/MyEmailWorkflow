// Assistente (D12): chat in streaming con Ollama su una conversazione o su una bozza.
// In lettura risponde su ciò che c'è scritto; in composizione propone testo da mettere nella bozza.

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AssistantMessageDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { assistantMessages, conversations, drafts, messages } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { config } from '../config.ts';
import type { Llm } from './classify.ts';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Generatore di testo a pezzi (Ollama in produzione, finto nei test). */
export type ChatStream = (turns: ChatTurn[], signal?: AbortSignal) => AsyncIterable<string>;

export const ollamaStream: ChatStream = async function* (turns, signal) {
  const res = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ model: config.ollama.llmModel, stream: true, options: { temperature: 0.4 }, messages: turns }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (ev.error) throw new Error(ev.error);
      if (ev.message?.content) yield ev.message.content;
    }
  }
};

/** Azioni rapide (lettura) e ritocchi (composizione): istruzioni complete per il modello. */
const ACTIONS = {
  summarize: { mode: 'read', prompt: 'Riassumi la conversazione in poche frasi: chi scrive, cosa si chiede, a che punto è.' },
  needs_reply: {
    mode: 'read',
    prompt: 'Cosa richiede una mia risposta o un mio intervento in questa conversazione? Elenca le richieste aperte rivolte a me, con "-". Se non ce ne sono, dillo.',
  },
  extract_tasks: {
    mode: 'read',
    prompt: 'Elenca le cose concrete che devo fare in base a questa conversazione, una per riga con "-", all\'infinito (es. "- Inviare il report"). Se non ce ne sono, dillo.',
  },
  translate: {
    mode: 'read',
    prompt: 'Traduci il messaggio aperto: in italiano se è in un\'altra lingua, altrimenti in inglese. Restituisci solo la traduzione.',
  },
  formal: { mode: 'compose', prompt: 'Riscrivi questo testo in un registro più formale, mantenendo il contenuto:' },
  shorter: { mode: 'compose', prompt: 'Riscrivi questo testo in modo più breve e diretto, mantenendo il contenuto essenziale:' },
  english: { mode: 'compose', prompt: 'Traduci questo testo in inglese, con un tono adatto a un\'email:' },
  fix: { mode: 'compose', prompt: 'Correggi ortografia, grammatica e punteggiatura di questo testo, senza cambiarne lo stile:' },
  rephrase: { mode: 'compose', prompt: 'Riformula questo testo con parole diverse, mantenendo significato e tono:' },
} as const;

export type AssistantAction = keyof typeof ACTIONS;

export const chatInputSchema = z
  .object({
    conversationId: z.string().nullable().optional(),
    draftId: z.string().nullable().optional(),
    mode: z.enum(['read', 'compose']),
    /** Messaggio in focus nel carosello (lettura). */
    messageId: z.string().nullable().optional(),
    /** Testo della bozza come lo vede l'utente (composizione), anche se non ancora salvato. */
    draftBody: z.string().max(100_000).optional(),
    action: z.enum(Object.keys(ACTIONS) as [AssistantAction, ...AssistantAction[]]).optional(),
    /** Ciò che l'utente ha scritto, o l'etichetta dell'azione rapida. */
    text: z.string().trim().min(1).max(4000),
  })
  .refine((i) => i.conversationId || i.draftId, { message: 'Serve una conversazione o una bozza' });

export type ChatInput = z.infer<typeof chatInputSchema>;

const MAX_MESSAGES = 12;
const MAX_CHARS_PER_MESSAGE = 1500;
const HISTORY = 8;

const WHO =
  'Nei messaggi, "Tu (l\'utente)" indica i messaggi scritti dall\'utente con cui stai parlando: rivolgiti a lui con il tu ' +
  '("hai scritto", "Mario ti chiede"). Tu, assistente, non compari mai nella conversazione. ';

const SYSTEM_READ =
  "Sei l'assistente di posta personale dell'utente. " +
  WHO +
  'Rispondi in italiano, in modo conciso e concreto, usando solo le informazioni presenti. ' +
  'Testo semplice: niente titoli né grassetti; per gli elenchi usa righe che iniziano con "-".';

const SYSTEM_COMPOSE =
  "Sei l'assistente di posta personale dell'utente e lo aiuti a scrivere un'email. " +
  WHO +
  "Rispondi SOLO con il testo da inserire nell'email, senza premesse, commenti, virgolette, oggetto o firma. " +
  "Scrivi in prima persona come l'utente, nella lingua della conversazione salvo richiesta diversa.";

export const threadOf = (i: { conversationId?: string | null; draftId?: string | null }): string | null =>
  i.conversationId ? i.conversationId : i.draftId && i.draftId !== 'new' ? `draft:${i.draftId}` : null;

const toDto = (r: typeof assistantMessages.$inferSelect): AssistantMessageDto => ({
  id: r.id,
  role: r.role,
  mode: r.mode,
  content: r.content,
  createdAt: r.createdAt,
});

export class AssistantService {
  private ideas = new Map<string, { key: string; ideas: { title: string; description: string }[] }>();

  constructor(private deps: { db: Db; stream: ChatStream; llm: Llm }) {}

  thread(thread: string): AssistantMessageDto[] {
    return this.deps.db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.thread, thread))
      .orderBy(asc(assistantMessages.createdAt))
      .all()
      .map(toDto);
  }

  clear(thread: string) {
    this.deps.db.delete(assistantMessages).where(eq(assistantMessages.thread, thread)).run();
  }

  /** La chat di una nuova mail passa alla conversazione nata dall'invio. */
  moveThread(from: string, to: string) {
    this.deps.db.update(assistantMessages).set({ thread: to }).where(eq(assistantMessages.thread, from)).run();
  }

  /** Testo della conversazione per il modello: oggetto, sintesi, ultimi messaggi. */
  private context(conversationId: string | null, focusId?: string | null): string {
    if (!conversationId) return 'Nuova email: non c\'è ancora una conversazione.';
    const { db } = this.deps;
    const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (!conv) return '';
    const all = db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
      .orderBy(asc(messages.date))
      .all();
    const shown = all.slice(-MAX_MESSAGES);
    const lines = shown.map((m) => {
      const who = m.direction === 'out' ? "Tu (l'utente)" : m.fromName || m.fromAddress || 'Sconosciuto';
      const when = new Date(m.date).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
      const n = all.indexOf(m) + 1;
      const mark = m.id === focusId ? ' (APERTO)' : '';
      return `Messaggio ${n} di ${all.length}${mark} · [${when}] ${who}:\n${(m.bodyTextClean || m.bodyText || '').slice(0, MAX_CHARS_PER_MESSAGE)}`;
    });
    return [
      `Oggetto: ${conv.subject ?? '(nessuno)'}`,
      conv.summaryDetailed || conv.summary ? `Sintesi: ${conv.summaryDetailed || conv.summary}` : '',
      '',
      lines.join('\n\n---\n\n'),
    ]
      .filter((l, i) => l || i === 2)
      .join('\n');
  }

  private draftBody(input: ChatInput): string {
    if (input.draftBody !== undefined) return input.draftBody;
    if (!input.draftId || input.draftId === 'new') return '';
    return this.deps.db.select({ body: drafts.body }).from(drafts).where(eq(drafts.id, input.draftId)).get()?.body ?? '';
  }

  /** Ultima proposta dell'assistente, oppure la bozza: è il testo su cui agiscono i ritocchi. */
  private retouchTarget(thread: string | null, input: ChatInput): string {
    if (thread) {
      const last = this.deps.db
        .select()
        .from(assistantMessages)
        .where(and(eq(assistantMessages.thread, thread), eq(assistantMessages.role, 'assistant'), eq(assistantMessages.mode, 'compose')))
        .orderBy(desc(assistantMessages.createdAt))
        .get();
      if (last) return last.content;
    }
    return this.draftBody(input);
  }

  /** Risposta in streaming; a fine risposta la coppia domanda/risposta resta nella chat. */
  async *chat(input: ChatInput, signal?: AbortSignal): AsyncGenerator<string> {
    const thread = threadOf(input);
    const action = input.action ? ACTIONS[input.action] : undefined;
    const mode = action?.mode ?? input.mode;
    const conversationId = input.conversationId ?? null;

    let request = input.text;
    if (action?.mode === 'read') request = action.prompt;
    if (action?.mode === 'compose') {
      const target = this.retouchTarget(thread, input).trim();
      if (!target) throw new Error('Non c\'è ancora un testo da ritoccare: scrivi nella bozza o chiedi una proposta.');
      request = `${action.prompt}\n\n${target}`;
    }

    const context = this.context(conversationId, input.messageId);
    const draft = mode === 'compose' ? this.draftBody(input).trim() : '';
    const system = [
      mode === 'compose' ? SYSTEM_COMPOSE : SYSTEM_READ,
      '',
      'CONVERSAZIONE',
      context,
      draft ? `\nBOZZA ATTUALE DELL'UTENTE\n${draft}` : '',
    ].join('\n');

    const history = thread
      ? this.deps.db
          .select()
          .from(assistantMessages)
          .where(eq(assistantMessages.thread, thread))
          .orderBy(desc(assistantMessages.createdAt))
          .limit(HISTORY)
          .all()
          .reverse()
      : [];
    const turns: ChatTurn[] = [
      { role: 'system', content: system },
      ...history.map((h) => ({ role: h.role, content: h.content }) as ChatTurn),
      { role: 'user', content: request },
    ];

    const startedAt = now();
    let out = '';
    for await (const piece of this.deps.stream(turns, signal)) {
      out += piece;
      yield piece;
    }
    const answer = out.trim();
    if (thread && answer) {
      this.deps.db
        .insert(assistantMessages)
        .values([
          { id: newId(), thread, role: 'user', mode, content: input.text, createdAt: startedAt },
          { id: newId(), thread, role: 'assistant', mode, content: answer, createdAt: Math.max(now(), startedAt + 1) },
        ])
        .run();
    }
  }

  /** "Come potresti rispondere": 2-3 idee (titolo + una riga), ricalcolate solo se arriva un messaggio nuovo. */
  async replyIdeas(conversationId: string): Promise<{ title: string; description: string }[]> {
    const last = this.deps.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
      .orderBy(desc(messages.date))
      .get();
    if (!last) return [];
    const cached = this.ideas.get(conversationId);
    if (cached?.key === last.id) return cached.ideas;
    const out = await this.deps.llm<{ idee?: { titolo?: string; descrizione?: string }[] }>(
      `${SYSTEM_READ} Rispondi solo con un oggetto JSON.`,
      [
        this.context(conversationId),
        '',
        'Proponi da 2 a 3 modi diversi in cui io potrei rispondere all\'ultimo messaggio.',
        'JSON: {"idee": [{"titolo": "massimo 5 parole, all\'imperativo", "descrizione": "una riga su cosa dire"}]}',
      ].join('\n'),
    );
    const ideas = (out.idee ?? [])
      .map((i) => ({ title: (i.titolo ?? '').trim(), description: (i.descrizione ?? '').trim() }))
      .filter((i) => i.title)
      .slice(0, 3);
    this.ideas.set(conversationId, { key: last.id, ideas });
    return ideas;
  }
}
