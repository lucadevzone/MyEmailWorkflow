import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage } from '../src/ingest/ingest.ts';
import { ConversationService } from '../src/conversations/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { chunks, conversations, jobs, suggestions } from '../src/db/schema.ts';
import { chunkText, similarConversations } from '../src/ai/embed.ts';

/** Embedding finto: parole → dimensioni (hash), normalizzato. Testi con parole in comune sono vicini. */
const fakeEmbed = async (texts: string[]) =>
  texts.map((t) => {
    const v = new Array(1024).fill(0);
    for (const w of t.toLowerCase().match(/\p{L}{4,}/gu) ?? []) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 1024] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

/** LLM finto: sceglie il progetto con il nome indicato leggendo le etichette P1, P2… del prompt. */
let llmAnswer: (prompt: string) => object;
let prompts: string[];
const pick = (name: string, confidenza = 0.9) => (prompt: string) => {
  const m = new RegExp(`^P(\\d+): ${name}$`, 'm').exec(prompt);
  return m ? { scelta: `P${m[1]}`, confidenza, motivo: `Riguarda ${name}` } : { scelta: 'nessuno', confidenza: 0.2 };
};

let s: ReturnType<typeof buildServices>;
let accountId: string;
let pnrr: string;
let corso: string;
let uid = 1;
const conv = () => new ConversationService(s.db);
/** Ultimo prompt di classificazione (l'LLM riceve anche quelli di task e azioni). */
const classifyPrompt = () => prompts.filter((p) => p.includes('Progetti candidati')).at(-1)!;
/** Solo i suggerimenti di progetto (ci sono anche i task, es. "rispondere"). */
const projectSugs = <T extends { kind: string }>(c: { suggestions: T[] } | undefined): T[] =>
  (c?.suggestions ?? []).filter((x) => x.kind === 'project' || x.kind === 'new_project');

const mail = (o: { id: string; from: string; subject: string; body: string; extra?: string; date?: string }) =>
  ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
    uid: uid++,
    mailbox: 'All',
    source: Buffer.from(
      [`Message-ID: ${o.id}`, `From: ${o.from}`, 'To: me@gmail.com', `Subject: ${o.subject}`, `Date: ${o.date ?? new Date().toUTCString()}`, o.extra, 'Content-Type: text/plain; charset=utf-8']
        .filter(Boolean)
        .join('\r\n') + `\r\n\r\n${o.body}`,
    ),
    flags: [],
    labels: [],
  });

beforeEach(() => {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  prompts = [];
  llmAnswer = pick('PNRR');
  s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
    createProvider: () => {
      throw new Error('no imap');
    },
    summarizer: async () => ({ breve: 'sintesi' }),
    embedder: fakeEmbed,
    llm: (async (_system: string, user: string) => {
      prompts.push(user);
      return llmAnswer(user);
    }) as never,
  });
  accountId = s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;
  const projects = new ProjectService(db);
  pnrr = projects.create({ name: 'PNRR', description: 'Rendicontazione del progetto PNRR', outgoingAccountId: accountId }).id;
  corso = projects.create({ name: 'Corso', description: 'Didattica del corso di Basi di dati', outgoingAccountId: accountId }).id;
});

/** Una conversazione già smistata in PNRR, da cui imparare. */
async function seedPnrr() {
  const r = await mail({ id: '<seed@x>', from: 'Mario Rossi <mario@x.it>', subject: 'Rendicontazione PNRR', body: 'Allego la rendicontazione trimestrale del progetto PNRR con le spese del personale.' });
  s.actions.move(r.conversationId, pnrr);
  await s.jobs.drain();
}

describe('embedding', () => {
  it('divide il testo in blocchi con l\'oggetto come contesto', () => {
    const parts = chunkText('Oggetto', `${'a'.repeat(1000)}\n\n${'b'.repeat(1000)}\n\n${'c'.repeat(100)}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.startsWith('Oggetto')).toBe(true);
  });

  it('indicizza i messaggi non rumore e trova le conversazioni simili', async () => {
    await seedPnrr();
    const r = await mail({ id: '<n@x>', from: 'anna@y.it', subject: 'Spese personale', body: 'Mancano le spese del personale nella rendicontazione trimestrale.' });
    await mail({ id: '<z@x>', from: 'news@shop.it', subject: 'Offerte', body: 'saldi', extra: 'List-Unsubscribe: <mailto:u@shop.it>' });
    await s.jobs.drain();
    expect(s.db.select().from(chunks).all().length).toBe(2); // il rumore non si indicizza
    const near = similarConversations(s.sqlite, r.conversationId);
    expect(near[0]).toMatchObject({ projectId: pnrr });
    expect(near[0]!.similarity).toBeGreaterThan(0.3);
  });
});

describe('progetto suggerito', () => {
  it('suggerisce il progetto giusto con motivo e confidenza; i candidati vanno all\'LLM', async () => {
    await seedPnrr();
    const r = await mail({ id: '<n@x>', from: 'Mario Rossi <mario@x.it>', subject: 'Spese personale', body: 'Ti mando le spese del personale per la rendicontazione PNRR.' });
    await s.jobs.drain();
    const last = classifyPrompt();
    expect(last).toMatch(/^P1: PNRR$/m); // PNRR è il primo candidato grazie a persone e somiglianza
    expect(last).toContain('descrizione: Rendicontazione del progetto PNRR');
    expect(last).toContain('conversazioni recenti: Rendicontazione PNRR');
    const [sug] = projectSugs(conv().list({ view: 'inbox' }).find((c) => c.id === r.conversationId));
    // Una sola conversazione di storia: vota solo l'LLM, quindi resta un suggerimento (RF-E6).
    expect(sug).toMatchObject({ kind: 'project', payload: { projectId: pnrr, projectName: 'PNRR', reason: 'Riguarda PNRR', votes: ['llm'], ruleOk: false, ruleWhy: 'un solo segnale' } });
    expect(sug!.confidence).toBeCloseTo(0.33, 2);
  });

  it('con abbastanza storia i segnali concordano e la regola dello spostamento automatico è soddisfatta', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await mail({ id: `<h${i}@x>`, from: 'Mario Rossi <mario@x.it>', subject: `Rendicontazione PNRR ${i}`, body: 'Allego la rendicontazione trimestrale del progetto PNRR con le spese del personale.' });
      s.actions.move(r.conversationId, pnrr);
    }
    await s.jobs.drain();
    const r = await mail({ id: '<n2@x>', from: 'Mario Rossi <mario@x.it>', subject: 'Spese personale', body: 'Ti mando le spese del personale per la rendicontazione PNRR.' });
    await s.jobs.drain();
    const [sug] = projectSugs(conv().list({ view: 'inbox' }).find((c) => c.id === r.conversationId));
    expect(sug!.payload).toMatchObject({ projectId: pnrr, ruleOk: true, ruleWhy: null });
    expect((sug!.payload as { votes: string[] }).votes.sort()).toEqual(['content', 'llm', 'people']);
    expect((sug!.payload as { reason: string }).reason).toContain('Mario Rossi: 5 conversazioni su 5 in PNRR');
  });

  it('smistamento automatico: prima osserva, si attiva dopo 10 casi giusti, annulla blocca il mittente, tenere conferma', async () => {
    const { autoSortLog, activities } = await import('../src/db/schema.ts');
    const { autoSortStats } = await import('../src/ai/auto-sort-log.ts');
    s.settings.update({ autoSortMode: 'auto' });
    for (let i = 1; i <= 5; i++) {
      const r = await mail({ id: `<g${i}@x>`, from: 'Mario Rossi <mario@x.it>', subject: `Rendicontazione PNRR ${i}`, body: 'Rendicontazione trimestrale del progetto PNRR, spese del personale.' });
      s.actions.move(r.conversationId, pnrr);
    }
    await s.jobs.drain();
    const newMail = async (n: number) => {
      const r = await mail({ id: `<m${n}@x>`, from: 'Mario Rossi <mario@x.it>', subject: `Spese ${n}`, body: 'Ti mando le spese del personale per la rendicontazione PNRR.' });
      await s.jobs.drain();
      return r.conversationId;
    };
    const projectOf = (id: string) => s.db.select().from(conversations).where(eq(conversations.id, id)).get()!.projectId;

    // 1. In osservazione: la regola è soddisfatta ma non è ancora affidabile → resta un suggerimento.
    const a = await newMail(1);
    expect(projectOf(a)).toBeNull();
    expect(s.db.select().from(autoSortLog).all()).toMatchObject([{ conversationId: a, projectId: pnrr, mode: 'shadow', outcome: null, sender: 'mario@x.it' }]);
    s.suggestions.accept(projectSugs(conv().list({ view: 'inbox' }).find((c) => c.id === a))[0]!.id);
    expect(autoSortStats(s.db)).toMatchObject({ agree: 1, total: 1, reliable: false });

    // 2. Dopo 10 decisioni confermate su 10 la regola è affidabile: la conversazione nuova si sposta da sola.
    const t = Date.now();
    for (let i = 0; i < 9; i++) s.db.insert(autoSortLog).values({ id: `ok${i}`, conversationId: `c${i}`, projectId: pnrr, sender: 'x@y.it', mode: 'shadow', outcome: 'agree', createdAt: t, resolvedAt: t }).run();
    expect(autoSortStats(s.db).reliable).toBe(true);
    const b = await newMail(2);
    expect(projectOf(b)).toBe(pnrr);
    expect(conv().list({ view: 'project', projectId: pnrr }).find((c) => c.id === b)!.autoSorted).toBe(true);
    expect(s.db.select().from(activities).all().filter((x) => x.kind === 'auto_sort')).toHaveLength(1);

    // 3. Tenerla: il segno sparisce e conta come giusta.
    s.actions.keepAutoSort(b);
    expect(conv().list({ view: 'project', projectId: pnrr }).find((c) => c.id === b)!.autoSorted).toBe(false);

    // 4. Annullarne una: torna in Da smistare, conta come errore e blocca Mario → PNRR.
    const c = await newMail(3);
    expect(projectOf(c)).toBe(pnrr);
    s.actions.move(c, null);
    await s.jobs.drain();
    expect(projectOf(c)).toBeNull();
    const sug = projectSugs(conv().list({ view: 'inbox' }).find((x) => x.id === c))[0];
    expect(sug?.payload).toMatchObject({ projectId: pnrr, ruleOk: false, ruleWhy: 'già rifiutato per questo mittente' });
    const d = await newMail(4);
    expect(projectOf(d)).toBeNull(); // niente più automatico per Mario → PNRR

    // 5. Spento: nessun suggerimento di progetto.
    s.settings.update({ autoSortMode: 'off' });
    const e = await newMail(5);
    expect(projectSugs(conv().list({ view: 'inbox' }).find((x) => x.id === e))).toEqual([]);
  });

  it('pausa dell\'analisi: i lavori restano in coda e ripartono alla ripresa', async () => {
    s.settings.update({ aiPaused: true });
    // Non appena ricevuta (quella si analizzerebbe anche in pausa): di qualche giorno fa.
    const date = new Date(Date.now() - 5 * 86_400_000).toUTCString();
    const r = await mail({ id: '<p@x>', from: 'mario@x.it', subject: 'Spese', body: 'spese del personale PNRR', date });
    await s.jobs.drain();
    const summaryOf = () => s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!.summary;
    expect(summaryOf()).toBeNull();
    const st = s.jobs.status();
    expect(st.pending).toBeGreaterThan(0);
    expect(st.byKind.summarize).toBe(1);
    s.settings.update({ aiPaused: false });
    await s.jobs.drain();
    expect(summaryOf()).toBe('sintesi');
    expect(s.jobs.status().pending).toBe(0);
  });

  it('dopo uno spostamento propone le altre di Da smistare: stesso mittente e contenuto simile, non quelle estranee', async () => {
    const { relatedForMove } = await import('../src/conversations/related.ts');
    llmAnswer = () => ({ scelta: 'nessuno', confidenza: 0 }); // nessun suggerimento: contano solo mittente e contenuto
    const a = await mail({ id: '<r1@x>', from: 'Mario Rossi <mario@x.it>', subject: 'Spese', body: 'Rendicontazione trimestrale del progetto PNRR, spese del personale.' });
    const b = await mail({ id: '<r2@x>', from: 'Mario Rossi <mario@x.it>', subject: 'Ciao', body: 'Ci vediamo domani al bar?' });
    const c = await mail({ id: '<r3@x>', from: 'anna@y.it', subject: 'Spese', body: 'Rendicontazione trimestrale del progetto PNRR, spese del personale.' });
    const d = await mail({ id: '<r4@x>', from: 'zio@z.it', subject: 'Ricetta', body: 'La torta di mele si fa con tre uova.' });
    await s.jobs.drain();
    s.actions.move(a.conversationId, pnrr);
    const related = relatedForMove(s.sqlite, a.conversationId, pnrr);
    const ids = related.items.map((i) => i.conversationId);
    expect(ids).toContain(b.conversationId); // stesso mittente
    expect(ids).toContain(c.conversationId); // contenuto simile
    expect(ids).not.toContain(d.conversationId);
    expect(related.items.find((i) => i.conversationId === b.conversationId)!.reasons).toContain('stesso mittente');
    expect(related.items.find((i) => i.conversationId === c.conversationId)!.reasons).toContain('contenuto simile');
    expect(related.items[0]!.conversationId).toBe(b.conversationId); // il mittente conta di più
  });

  it('dopo un\'archiviazione propone le altre nello stesso posto (stesso mittente o contenuto simile)', async () => {
    const { relatedFor } = await import('../src/conversations/related.ts');
    llmAnswer = () => ({ scelta: 'nessuno', confidenza: 0 });
    const a = await mail({ id: '<q1@x>', from: 'promo@shop.it', subject: 'Offerta', body: 'Sconto del 20% su tutto il catalogo questa settimana.' });
    const b = await mail({ id: '<q2@x>', from: 'promo@shop.it', subject: 'Altra offerta', body: 'Nuovi arrivi in negozio.' });
    const c = await mail({ id: '<q3@x>', from: 'zio@z.it', subject: 'Ricetta', body: 'La torta di mele si fa con tre uova.' });
    const inProject = await mail({ id: '<q4@x>', from: 'promo@shop.it', subject: 'Offerta PNRR', body: 'Sconto.' });
    await s.jobs.drain();
    s.actions.move(inProject.conversationId, pnrr); // in un altro posto: non va proposta
    s.actions.archive(a.conversationId);
    const ids = relatedFor(s.sqlite, a.conversationId, { mode: 'archive' }).items.map((i) => i.conversationId);
    expect(ids).toContain(b.conversationId);
    expect(ids).not.toContain(c.conversationId);
    expect(ids).not.toContain(inProject.conversationId);
  });

  it('accettare sposta la conversazione; scartare non ripropone quel progetto', async () => {
    await seedPnrr();
    const a = await mail({ id: '<a@x>', from: 'mario@x.it', subject: 'Spese', body: 'spese del personale PNRR' });
    const b = await mail({ id: '<b@x>', from: 'mario@x.it', subject: 'Altre spese', body: 'altre spese del personale PNRR' });
    await s.jobs.drain();
    const sugOf = (id: string) => projectSugs(conv().list({ view: 'inbox' }).find((c) => c.id === id))[0];

    s.suggestions.accept(sugOf(a.conversationId)!.id);
    expect(s.db.select().from(conversations).where(eq(conversations.id, a.conversationId)).get()!.projectId).toBe(pnrr);

    s.suggestions.reject(sugOf(b.conversationId)!.id);
    await mail({ id: '<b2@x>', from: 'mario@x.it', subject: 'Re: Altre spese', body: 'ancora spese PNRR', extra: 'In-Reply-To: <b@x>' });
    await s.jobs.drain();
    expect(classifyPrompt()).not.toMatch(/^P\d+: PNRR$/m);
    expect(sugOf(b.conversationId)).toBeUndefined();
  });

  it('nessun suggerimento se l\'LLM non è convinto o la confidenza è bassa', async () => {
    llmAnswer = () => ({ scelta: 'nessuno', confidenza: 0.1 });
    const r = await mail({ id: '<a@x>', from: 'x@z.it', subject: 'Ciao', body: 'come stai' });
    await s.jobs.drain();
    expect(projectSugs(conv().list({ view: 'inbox' })[0])).toEqual([]);
    expect(s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!.classifiedAt).not.toBeNull();

    llmAnswer = pick('Corso', 0.3); // LLM poco sicuro e nessun indizio oggettivo
    await mail({ id: '<b@x>', from: 'y@z.it', subject: 'Domanda', body: 'una domanda' });
    await s.jobs.drain();
    expect(s.db.select().from(suggestions).all().filter((x) => x.kind === 'project')).toHaveLength(0);
  });

  it('può proporre un progetto nuovo', async () => {
    llmAnswer = () => ({ scelta: 'nuovo', confidenza: 0.8, motivo: 'Tema non coperto', nome_nuovo: 'Convegno ICAR' });
    await mail({ id: '<a@x>', from: 'x@z.it', subject: 'Convegno', body: 'organizzazione del convegno' });
    await s.jobs.drain();
    expect(projectSugs(conv().list({ view: 'inbox' })[0])[0]).toMatchObject({ kind: 'new_project', payload: { projectName: 'Convegno ICAR' } });
  });

  it('il rumore non si classifica; spostare a mano cancella i suggerimenti in attesa', async () => {
    await mail({ id: '<n@x>', from: 'news@shop.it', subject: 'Offerte', body: 'saldi', extra: 'List-Unsubscribe: <mailto:u@shop.it>' });
    expect(s.db.select().from(jobs).all().filter((j) => j.kind === 'classify')).toHaveLength(0);

    await seedPnrr();
    const r = await mail({ id: '<a@x>', from: 'mario@x.it', subject: 'Spese', body: 'spese PNRR personale' });
    await s.jobs.drain();
    expect(projectSugs(conv().list({ view: 'inbox' })[0])).toHaveLength(1);
    s.actions.move(r.conversationId, corso);
    expect(s.db.select().from(suggestions).all().filter((x) => x.status === 'pending' && x.kind === 'project')).toHaveLength(0);
  });
});
