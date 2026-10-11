// Assistente (D12): chat in streaming con Ollama su una conversazione o su una bozza.
// In lettura risponde su ciò che c'è scritto; in composizione propone testo da mettere nella bozza.

import { CHARS_PER_TOKEN, llmRequest, warnIfTruncated } from './ollama-options.ts';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AssistantMessageDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { assistantMessages, attachments, conversations, drafts, messages } from '../db/schema.ts';
import type { SearchService } from '../search/service.ts';
import { newId, now } from '../lib/ids.ts';
import { config } from '../config.ts';
import type { Llm } from './classify.ts';
import { projectContext, type BlobReader } from './project-context.ts';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Generatore di testo a pezzi (Ollama in produzione, finto nei test). */
export type ChatStream = (turns: ChatTurn[], signal?: AbortSignal, opts?: { temperature?: number }) => AsyncIterable<string>;

export const ollamaStream: ChatStream = async function* (turns, signal, opts) {
  const res = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ model: config.ollama.llmModel, stream: true, ...llmRequest(opts?.temperature ?? 0.4), messages: turns }),
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
      const ev = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean; prompt_eval_count?: number };
      if (ev.error) throw new Error(ev.error);
      if (ev.done) warnIfTruncated(ev.prompt_eval_count, 'assistente');
      if (ev.message?.content) yield ev.message.content;
    }
  }
};

/** Azioni rapide (lettura) e ritocchi (composizione): istruzioni complete per il modello. */
const ACTIONS = {
  summarize: {
    mode: 'read',
    prompt: 'Riassumi la conversazione in poche frasi: chi scrive, cosa si chiede o si propone (con date, orari, cifre e nomi di file importanti) e a che punto è.',
  },
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
/** Messaggi al massimo nei brani di una domanda su tutta la posta. */
const MAX_PASSAGES = 14;

/** Un messaggio citabile in una risposta su tutta la posta: [n] → quel messaggio. */
export interface AskPassage {
  n: number;
  messageId: string;
  conversationId: string;
  projectId: string | null;
  isNoise: boolean;
  title: string;
  from: string;
  date: number;
}

/** Token tenuti liberi per la risposta del modello. */
const REPLY_TOKENS = 1500;

const WHO =
  'Nei messaggi, quelli "scritti dall\'utente" sono di chi ti sta parlando: rivolgiti a lui con il tu ("hai scritto", "Mario ti chiede"); ' +
  'tutti gli altri sono scritti dalla persona indicata, anche se ha lo stesso nome dell\'utente. Tu, assistente, non compari mai nei messaggi. ';
/** Etichetta del mittente: l'utente non va confuso con un omonimo. */
const USER_LABEL = "l'UTENTE (cioè chi ti fa la domanda)";

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

  constructor(private deps: { db: Db; stream: ChatStream; llm: Llm; readBlob?: BlobReader; search?: SearchService }) {}

  /** Progetto della conversazione o della bozza (per il contesto: note, risorse, allegati). */
  private projectOf(input: { conversationId?: string | null; draftId?: string | null }): string | null {
    const { db } = this.deps;
    if (input.conversationId) return db.select({ p: conversations.projectId }).from(conversations).where(eq(conversations.id, input.conversationId)).get()?.p ?? null;
    if (input.draftId && input.draftId !== 'new') return db.select({ p: drafts.projectId }).from(drafts).where(eq(drafts.id, input.draftId)).get()?.p ?? null;
    return null;
  }

  private projectBlock(input: { conversationId?: string | null; draftId?: string | null }): string {
    if (!this.deps.readBlob) return '';
    const text = projectContext(this.deps.db, this.projectOf(input), this.deps.readBlob);
    return text ? `\nCONTESTO DEL PROGETTO (note e materiali dell'utente: usali se pertinenti)\n${text}` : '';
  }

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
  /** maxChars: spazio disponibile nel contesto del modello; se non basta si tolgono i messaggi più vecchi. */
  private context(conversationId: string | null, focusId?: string | null, maxChars = Infinity): string {
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
    let shown = all.slice(-MAX_MESSAGES);
    const render = (m: (typeof all)[number]) => {
      const who = m.direction === 'out' ? USER_LABEL : m.fromName || m.fromAddress || 'Sconosciuto';
      const when = new Date(m.date).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
      const n = all.indexOf(m) + 1;
      const mark = m.id === focusId ? ' (APERTO)' : '';
      const files = this.attachmentNames(m.id);
      const att = files.length ? `\nAllegati: ${files.join(', ')}` : '';
      return `Messaggio ${n} di ${all.length}${mark} · [${when}] scritto da ${who}:${att}\n${(m.bodyTextClean || m.bodyText || '').slice(0, MAX_CHARS_PER_MESSAGE)}`;
    };
    let lines = shown.map(render);
    const head = `Oggetto: ${conv.subject ?? '(nessuno)'}\n${conv.summaryDetailed || conv.summary || ''}`.length + 40;
    const size = () => head + lines.reduce((n, l) => n + l.length + 7, 0);
    // Fuori budget: via i messaggi più vecchi, mai quello aperto (la sintesi copre il resto).
    while (shown.length > 1 && size() > maxChars) {
      const drop = shown.findIndex((m) => m.id !== focusId);
      if (drop < 0) break;
      shown = shown.filter((_, i) => i !== drop);
      lines = shown.map(render);
    }
    if (size() > maxChars) lines = lines.map((l) => l.slice(0, Math.max(500, maxChars - head)));
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
  /** opts.persist = false: non salva la chat (banco di prova). */
  async *chat(input: ChatInput, signal?: AbortSignal, opts: { persist?: boolean } = {}): AsyncGenerator<string> {
    const thread = opts.persist === false ? null : threadOf(input);
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

    const draft = mode === 'compose' ? this.draftBody(input).trim() : '';
    const project = this.projectBlock(input);
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
    // Budget: il contesto del modello meno lo spazio per la risposta e tutto il resto del prompt.
    const fixed = (mode === 'compose' ? SYSTEM_COMPOSE : SYSTEM_READ).length + project.length + draft.length + request.length +
      history.reduce((n, h) => n + h.content.length, 0);
    const budget = (config.ollama.numCtx - REPLY_TOKENS) * CHARS_PER_TOKEN - fixed;
    const context = this.context(conversationId, input.messageId, Math.max(2000, budget));
    const system = [
      mode === 'compose' ? SYSTEM_COMPOSE : SYSTEM_READ,
      '',
      'CONVERSAZIONE',
      context,
      project,
      draft ? `\nBOZZA ATTUALE DELL'UTENTE\n${draft}` : '',
    ].join('\n');
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
        this.projectBlock({ conversationId }),
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

  /**
   * Domanda su più conversazioni (dalla ricerca): l'assistente legge sintesi e ultimi messaggi delle
   * conversazioni indicate, nell'ordine dato, e risponde citandole come [1], [2]… Non si salva.
   */
  /**
   * Domanda su tutta la posta: la ricerca sceglie i singoli messaggi più pertinenti (testo, significato,
   * nomi degli allegati); a ciascuno si affiancano il messaggio prima e quello dopo nella conversazione
   * (una risposta breve come "forse posso" ha senso solo con la domanda). Le citazioni [n] sono per messaggio.
   * conversationIds: se la barra di ricerca ha già trovato delle conversazioni, si cerca solo lì.
   */
  async prepareAsk(question: string, conversationIds: string[] = []): Promise<{ sources: AskPassage[]; turns: ChatTurn[] }> {
    const { db } = this.deps;
    const hits = this.deps.search ? await this.deps.search.searchMessages(question, { limit: 8, conversationIds }) : [];

    // Messaggi da mostrare: quelli trovati e i loro vicini, raggruppati per conversazione (in ordine di pertinenza).
    const byConv = new Map<string, Set<string>>();
    const hitIds = new Set(hits.map((h) => h.messageId));
    for (const h of hits) {
      const conv = db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, h.conversationId), isNull(messages.deletedAt)))
        .orderBy(asc(messages.date))
        .all()
        .map((m) => m.id);
      const i = conv.indexOf(h.messageId);
      const set = byConv.get(h.conversationId) ?? new Set<string>();
      for (const id of [conv[i - 1], h.messageId, conv[i + 1]]) if (id) set.add(id);
      byConv.set(h.conversationId, set);
    }

    const budget = (config.ollama.numCtx - REPLY_TOKENS) * CHARS_PER_TOKEN - 2500;
    const sources: AskPassage[] = [];
    const blocks: string[] = [];
    let used = 0;
    for (const [conversationId, ids] of byConv) {
      const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
      if (!conv) continue;
      const rows = db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
        .orderBy(asc(messages.date))
        .all()
        .filter((m) => ids.has(m.id));
      for (const m of rows) {
        if (sources.length >= MAX_PASSAGES) break;
        const files = this.attachmentNames(m.id);
        const who = m.direction === 'out' ? USER_LABEL : m.fromName || m.fromAddress || 'Sconosciuto';
        const when = new Date(m.date).toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        // Solo il testo nuovo: il testo citato confonde chi ha detto cosa.
        const body = (m.bodyTextClean ?? '').replace(/\s+/g, ' ').trim().slice(0, hitIds.has(m.id) ? 1000 : 500);
        const n = sources.length + 1;
        const block = [
          `[${n}] ${when} · scritto da ${who} · conversazione «${conv.subject ?? '(senza oggetto)'}»`,
          files.length ? `Allegati: ${files.join(', ')}` : '',
          body || (files.length ? '(nessun testo nuovo, solo allegati)' : '(nessun testo nuovo)'),
        ]
          .filter(Boolean)
          .join('\n');
        if (used + block.length > budget) break;
        used += block.length;
        blocks.push(block);
        sources.push({
          n,
          messageId: m.id,
          conversationId,
          projectId: conv.projectId,
          isNoise: conv.isNoise,
          title: conv.subject ?? '(senza oggetto)',
          from: m.direction === 'out' ? 'Tu' : who,
          date: m.date,
        });
      }
    }

    const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const system = [
      "Sei l'assistente di posta personale dell'utente. " + WHO,
      `Oggi è ${today}.`,
      'Qui sotto ci sono alcuni messaggi della posta dell\'utente scelti da una ricerca: alcuni sono pertinenti alla domanda, altri no.',
      'Rispondi in italiano, in poche frasi, basandoti su questi messaggi. Spesso bisogna collegare più messaggi (una domanda e la sua risposta) ' +
        'o leggere la data, il mittente e i nomi degli allegati.',
      'Dopo ogni informazione scrivi tra parentesi quadre il numero del messaggio da cui viene, ad esempio [2].',
      'Se nessun messaggio contiene ciò che serve, rispondi soltanto: "Non ho trovato la risposta nella posta." Non inventare nulla che non sia scritto.',
      'Testo semplice: niente titoli né grassetti; per gli elenchi usa righe che iniziano con "-".',
      '',
      'MESSAGGI',
      blocks.join('\n\n') || '(la ricerca non ha trovato messaggi)',
    ].join('\n');
    // Promemoria accanto alla domanda: i modelli piccoli dimenticano le citazioni chieste nel sistema.
    const user = `${question}\n\n(Dopo ogni informazione indica il messaggio con [n].)`;
    return { sources, turns: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  }

  async *ask(turns: ChatTurn[], signal?: AbortSignal): AsyncGenerator<string> {
    for await (const piece of this.deps.stream(turns, signal, { temperature: 0.1 })) yield piece;
  }

  /** Nomi degli allegati veri (non le immagini incorporate) di un messaggio. */
  private attachmentNames(messageId: string): string[] {
    return this.deps.db
      .select({ name: attachments.filename })
      .from(attachments)
      .where(and(eq(attachments.messageId, messageId), eq(attachments.isInline, false)))
      .all()
      .map((a) => a.name)
      .filter((n): n is string => !!n);
  }
}
