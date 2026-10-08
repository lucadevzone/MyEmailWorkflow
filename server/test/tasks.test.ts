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
import { conversations, jobs, messages as messagesTable } from '../src/db/schema.ts';
import { rankBetween } from '../src/lib/rank.ts';

describe('indici frazionari', () => {
  it('trova sempre una chiave intermedia, anche dopo molti inserimenti nello stesso punto', () => {
    let lo: string | null = null;
    const hi = rankBetween(null, null);
    const keys = [hi];
    for (let i = 0; i < 200; i++) {
      const k = rankBetween(lo, hi);
      expect(lo === null || k > lo).toBe(true);
      expect(k < hi).toBe(true);
      expect(k.endsWith('0')).toBe(false);
      keys.push(k);
      lo = k;
    }
    let top: string | null = null;
    for (let i = 0; i < 50; i++) {
      const k = rankBetween(null, top ?? keys[0]!);
      expect(k < (top ?? keys[0]!)).toBe(true);
      top = k;
    }
    expect(() => rankBetween('b', 'a')).toThrow();
  });
});

let s: ReturnType<typeof buildServices>;
let accountId: string;
let projectId: string;
let llm: (prompt: string) => object;
let uid = 1;

beforeEach(() => {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  llm = () => ({ task: [] });
  s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
    createProvider: () => {
      throw new Error('no imap');
    },
    summarizer: async () => ({ breve: 'x' }),
    embedder: async (texts) => texts.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
    llm: (async (system: string, user: string) => (system.includes('richieste esplicite') ? llm(user) : { scelta: 'nessuno' })) as never,
  });
  accountId = s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;
  projectId = new ProjectService(db).create({ name: 'PNRR', outgoingAccountId: accountId }).id;
});

const titles = () => s.tasks.forProject(projectId).filter((t) => t.status === 'open').map((t) => t.title);

describe('coda dei task', () => {
  it('in fondo per default, in cima su richiesta; riordino con una sola riga', () => {
    s.tasks.create({ projectId, title: 'A' });
    s.tasks.create({ projectId, title: 'B' });
    const c = s.tasks.create({ projectId, title: 'C', top: true });
    expect(titles()).toEqual(['C', 'A', 'B']);
    s.tasks.move(c.id, s.tasks.forProject(projectId).find((t) => t.title === 'B')!.id);
    expect(titles()).toEqual(['A', 'B', 'C']);
    s.tasks.move(c.id, null);
    expect(titles()).toEqual(['C', 'A', 'B']);
  });

  it('completare e riaprire: il riaperto torna in fondo; scadenza facoltativa validata', () => {
    const a = s.tasks.create({ projectId, title: 'A', dueDate: '2026-10-16' });
    s.tasks.create({ projectId, title: 'B' });
    s.tasks.update(a.id, { status: 'done' });
    expect(titles()).toEqual(['B']);
    expect(s.tasks.get(a.id)!.completedAt).not.toBeNull();
    s.tasks.update(a.id, { status: 'open' });
    expect(titles()).toEqual(['B', 'A']);
    expect(s.tasks.get(a.id)!.dueDate).toBe('2026-10-16');
  });
});

const mail = (id: string, subject: string, body: string, opts: { date?: string; noise?: boolean } = {}) =>
  ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
    uid: uid++, mailbox: 'All', flags: [], labels: [],
    source: Buffer.from(
      [`Message-ID: <${id}@x>`, `From: ${opts.noise ? 'news@shop.it' : 'Mario <mario@x.it>'}`, 'To: me@gmail.com', `Subject: ${subject}`,
        `Date: ${opts.date ?? new Date().toUTCString()}`, opts.noise ? 'List-Unsubscribe: <mailto:u@shop.it>' : '', 'Content-Type: text/plain; charset=utf-8']
        .filter(Boolean).join('\r\n') + `\r\n\r\n${body}`,
    ),
  });

describe('task suggeriti', () => {
  it('il calendario nel prompt risolve i giorni della settimana', async () => {
    const { calendarFrom } = await import('../src/ai/extract-tasks.ts');
    const cal = calendarFrom(new Date(2026, 9, 8)); // giovedì 8 ottobre 2026
    expect(cal.split('\n')[0]).toBe('giovedì 2026-10-08 (giorno del messaggio)');
    expect(cal).toContain('venerdì 2026-10-09');
  });

  it('riporta i task al punto di vista del destinatario', async () => {
    const { toFirstPerson } = await import('../src/ai/extract-tasks.ts');
    expect(toFirstPerson('Inviare la tua sezione del D4.1')).toBe('Inviare la mia sezione del D4.1');
    expect(toFirstPerson('Tuoi commenti al testo')).toBe('Miei commenti al testo');
    expect(toFirstPerson('Studiare la tutela')).toBe('Studiare la tutela');
  });

  it('estrae i task dalla posta in arrivo recente e li propone; accettarli crea il task nel progetto', async () => {
    llm = (prompt) => (prompt.includes('timesheet') ? { task: [{ titolo: 'Inviare i timesheet di settembre', scadenza: '2026-10-09', dettagli: null }] } : { task: [] });
    const r = await mail('a', 'Timesheet', 'Mi mandi i timesheet di settembre entro venerdì?');
    s.actions.move(r.conversationId, projectId);
    await s.jobs.drain();
    const conv = new ConversationService(s.db);
    const sug = conv.list({ view: 'project', projectId })[0]!.suggestions.find((x) => x.kind === 'task' && !x.payload.reply)!;
    expect(sug.payload).toMatchObject({ title: 'Inviare i timesheet di settembre', dueDate: '2026-10-09' });

    s.suggestions.accept(sug.id);
    const [task] = s.tasks.forProject(projectId);
    expect(task).toMatchObject({ title: 'Inviare i timesheet di settembre', dueDate: '2026-10-09', conversationId: r.conversationId, conversationSubject: 'Timesheet' });
    expect(conv.list({ view: 'project', projectId })[0]!.taskCount).toBe(1);
  });

  it('da Da smistare serve il progetto, e la conversazione lo segue', async () => {
    llm = () => ({ task: [{ titolo: 'Preparare il preventivo', scadenza: null }] });
    const r = await mail('a', 'Domanda', 'Mi prepari il preventivo?');
    await s.jobs.drain();
    const sug = new ConversationService(s.db).list({ view: 'inbox' })[0]!.suggestions.find((x) => x.kind === 'task' && !x.payload.reply)!;
    expect(() => s.suggestions.accept(sug.id)).toThrow('Scegli il progetto');
    s.suggestions.accept(sug.id, { projectId });
    expect(s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!.projectId).toBe(projectId);
    expect(titles()).toEqual(['Preparare il preventivo']);
  });

  it('propone sempre "rispondere", uno per conversazione, e lo toglie quando si risponde', async () => {
    llm = () => ({ task: [{ titolo: 'Rispondere a Mario entro sera', scadenza: null }] }); // doppione dell'LLM: scartato
    const r = await mail('a', 'Timesheet', 'Ciao, come va?');
    s.actions.move(r.conversationId, projectId);
    await s.jobs.drain();
    const replyTasks = () =>
      new ConversationService(s.db).list({ view: 'project', projectId })[0]!.suggestions.filter((x) => x.kind === 'task');
    expect(replyTasks().map((x) => [x.payload.title, x.payload.reply])).toEqual([['Rispondere a Mario — Timesheet', true]]);

    // Un secondo messaggio aggiorna il suggerimento invece di duplicarlo.
    await ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
      uid: uid++, mailbox: 'All', flags: [], labels: [],
      source: Buffer.from(`Message-ID: <b@x>\r\nIn-Reply-To: <a@x>\r\nFrom: Mario <mario@x.it>\r\nTo: me@gmail.com\r\nSubject: Re: Timesheet\r\nDate: ${new Date().toUTCString()}\r\n\r\nAllora?`),
    });
    await s.jobs.drain();
    expect(replyTasks()).toHaveLength(1);

    // Rispondo dall'app: il suggerimento sparisce.
    s.actions.compose({ projectId, replyToMessageId: s.db.select().from(messagesTable).all().at(-1)!.id, to: ['mario@x.it'], cc: [], bcc: [], subject: '', body: 'Eccomi', urgent: false });
    expect(replyTasks()).toHaveLength(0);
  });

  it('niente estrazione da storico, rumore o posta inviata', async () => {
    await mail('old', 'Vecchia', 'fai questo', { date: 'Mon, 01 Jan 2024 10:00:00 +0100' });
    await mail('n', 'Offerte', 'compra', { noise: true });
    expect(s.db.select().from(jobs).all().filter((j) => j.kind === 'extract_tasks')).toHaveLength(0);
  });
});
