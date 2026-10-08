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
/** Solo i suggerimenti di progetto (ci sono anche i task, es. "rispondere"). */
const projectSugs = (c: { suggestions: { kind: string }[] } | undefined) => (c?.suggestions ?? []).filter((x) => x.kind === 'project' || x.kind === 'new_project');

const mail = (o: { id: string; from: string; subject: string; body: string; extra?: string }) =>
  ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
    uid: uid++,
    mailbox: 'All',
    source: Buffer.from(
      [`Message-ID: ${o.id}`, `From: ${o.from}`, 'To: me@gmail.com', `Subject: ${o.subject}`, `Date: ${new Date().toUTCString()}`, o.extra, 'Content-Type: text/plain; charset=utf-8']
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
    const last = prompts.at(-1)!;
    expect(last).toMatch(/^P1: PNRR$/m); // PNRR è il primo candidato grazie a persone e somiglianza
    expect(last).toContain('descrizione: Rendicontazione del progetto PNRR');
    expect(last).toContain('conversazioni recenti: Rendicontazione PNRR');
    const [sug] = projectSugs(conv().list({ view: 'inbox' }).find((c) => c.id === r.conversationId));
    expect(sug).toMatchObject({ kind: 'project', payload: { projectId: pnrr, projectName: 'PNRR', reason: 'Riguarda PNRR' } });
    expect(sug!.confidence).toBeGreaterThan(0.6);
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
    expect(prompts.at(-1)).not.toMatch(/^P\d+: PNRR$/m);
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
