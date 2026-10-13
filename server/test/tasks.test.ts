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
import { applyAiWindow } from '../src/ai/window.ts';
import { analyzeFocused } from '../src/ai/focus.ts';
import { enqueueMissingAnalysis } from '../src/ai/missing.ts';

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

  it('il progetto conta i task aperti e quelli scaduti (per il badge nella barra)', () => {
    s.tasks.create({ projectId, title: 'Scaduto', dueDate: '2020-01-01' });
    s.tasks.create({ projectId, title: 'Futuro', dueDate: '2099-01-01' });
    const done = s.tasks.create({ projectId, title: 'Fatto', dueDate: '2020-01-01' });
    s.tasks.update(done.id, { status: 'done' });
    expect(new ProjectService(s.db).get(projectId)).toMatchObject({ openTaskCount: 2, overdueTaskCount: 1 });
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

describe('task di Da smistare', () => {
  it('Da smistare ha la sua lista; i task seguono la conversazione quando si sposta; News senza task', async () => {
    const inbox = () => s.tasks.forProject(null).filter((t) => t.status === 'open').map((t) => t.title);
    s.tasks.create({ projectId: null, title: 'Rinnovare SPID', dueDate: '2020-01-01' });
    const r = await mail('spid', 'Scadenza PosteID', 'Il servizio scade il 15/12');
    const reply = s.tasks.remindReply(r.conversationId);
    expect(reply.projectId).toBeNull();
    expect(inbox()).toEqual(['Rinnovare SPID', reply.title]);
    expect(new ConversationService(s.db).counts()).toMatchObject({ inboxOpenTasks: 2, inboxOverdueTasks: 1 });
    expect(titles()).toEqual([]);

    s.actions.move(r.conversationId, projectId);
    expect(inbox()).toEqual(['Rinnovare SPID']);
    expect(titles()).toEqual([reply.title]);
    s.actions.move(r.conversationId, null);
    expect(inbox()).toEqual(['Rinnovare SPID', reply.title]);

    const n = await mail('promo', 'Saldi', 'sconti', { noise: true });
    expect(() => s.tasks.remindReply(n.conversationId)).toThrow('News');
  });
});

describe("finestra dell'analisi", () => {
  it('la posta vecchia non entra nella coda del modello; la sintesi si fa su richiesta; allargando la finestra rientra', async () => {
    const pending = (kind: string) => s.db.select().from(jobs).all().filter((j) => j.kind === kind && j.status === 'pending').length;
    const old = await mail('old', 'Vecchia', 'Mi mandi il preventivo?', { date: 'Mon, 01 Jan 2024 10:00:00 +0100' });
    const recent = await mail('new', 'Recente', 'Mi mandi il preventivo?');
    const queued = s.db.select().from(jobs).all().filter((j) => j.status === 'pending' && ['summarize', 'classify'].includes(j.kind));
    expect(queued.map((j) => JSON.parse(j.payload).conversationId)).not.toContain(old.conversationId);
    expect(queued.map((j) => JSON.parse(j.payload).conversationId)).toContain(recent.conversationId);
    expect(pending('embed')).toBe(2); // l'indicizzazione vale per tutto lo storico

    await s.summarizeNow(old.conversationId);
    expect(new ConversationService(s.db).item(old.conversationId)!.summary).toBe('x');

    s.settings.update({ aiWindowDays: 0 });
    applyAiWindow(s.db, s.sqlite, () => enqueueMissingAnalysis(s.db));
    const all = s.db.select().from(jobs).all().filter((j) => j.status === 'pending' && j.kind === 'classify');
    expect(all.map((j) => JSON.parse(j.payload).conversationId)).toContain(old.conversationId);

    s.settings.update({ aiWindowDays: 90 });
    applyAiWindow(s.db, s.sqlite, () => enqueueMissingAnalysis(s.db));
    const back = s.db.select().from(jobs).all().filter((j) => j.status === 'pending' && j.kind === 'classify');
    expect(back.map((j) => JSON.parse(j.payload).conversationId)).not.toContain(old.conversationId);
  });
});

describe('conversazione aperta', () => {
  it("con l'analisi in pausa, la conversazione aperta si analizza lo stesso; le altre restano in coda", async () => {
    s.settings.update({ aiPaused: true });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toUTCString();
    const a = await mail('a', 'Preventivo', 'Mi mandi il preventivo?', { date: tenDaysAgo });
    const b = await mail('b', 'Altro', 'Ciao', { date: tenDaysAgo });
    const fresh = await mail('f', 'Appena arrivata', 'Ci vediamo domani?');
    await s.jobs.drain();
    const conv = new ConversationService(s.db);
    expect(conv.item(a.conversationId)!.summary).toBeNull(); // in pausa la posta non appena ricevuta resta in coda
    expect(conv.item(fresh.conversationId)!.summary).toBe('x'); // quella appena ricevuta si analizza subito

    const r = analyzeFocused(s.db, a.conversationId);
    expect(r.queued).toEqual(expect.arrayContaining(['embed', 'summarize', 'classify', 'extract_tasks']));
    await s.jobs.drain();
    expect(conv.item(a.conversationId)!.summary).toBe('x');
    expect(conv.item(b.conversationId)!.summary).toBeNull();

    const old = await mail('old', 'Vecchia', 'ciao', { date: 'Mon, 01 Jan 2024 10:00:00 +0100' });
    expect(analyzeFocused(s.db, old.conversationId).skipped).toBe('window');
  });
});

describe('fusione di progetti', () => {
  it('sposta conversazioni, task in coda, note e risorse; il sorgente sparisce', async () => {
    const projects = new ProjectService(s.db);
    const other = projects.create({ name: 'Vecchio', description: 'Gare e preventivi', outgoingAccountId: accountId }).id;
    s.tasks.create({ projectId, title: 'A' });
    s.tasks.create({ projectId: other, title: 'X' });
    s.tasks.create({ projectId: other, title: 'Y' });
    const r = await mail('m', 'Gara', 'ciao');
    s.actions.move(r.conversationId, other);
    s.notes.createNote({ projectId: other, body: 'nota del progetto' });
    s.notes.addFile({ projectId: other }, 'linee.txt', Buffer.from('testo'), 'text/plain');

    expect(() => projects.merge(other, other)).toThrow('diverso');
    expect(projects.merge(other, projectId)).toEqual({ movedConversations: 1 });
    expect(titles()).toEqual(['A', 'X', 'Y']);
    expect(s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!.projectId).toBe(projectId);
    expect(s.notes.resourcesForProject(projectId).map((x) => x.title)).toEqual(['linee.txt']);
    expect(projects.list().map((p) => p.name)).toEqual(['PNRR']);
    expect(projects.get(projectId)!.description).toBe('Gare e preventivi');
  });
});

describe('task suggeriti', () => {
  it('il calendario nel prompt risolve i giorni della settimana', async () => {
    const { calendarFrom } = await import('../src/ai/extract-tasks.ts');
    const cal = calendarFrom(new Date(2026, 9, 8)); // giovedì 8 ottobre 2026
    expect(cal.split('\n')[0]).toBe('giovedì 2026-10-08 (giorno del messaggio)');
    expect(cal).toContain('venerdì 2026-10-09');
  });

  it('porta i titoli all\'infinito', async () => {
    const { toInfinitive } = await import('../src/ai/extract-tasks.ts');
    expect(toInfinitive('Mandami i timesheet di settembre')).toBe('Inviare i timesheet di settembre');
    expect(toInfinitive('rispondi per confermare')).toBe('Rispondere per confermare');
    expect(toInfinitive('prenota la sala')).toBe('Prenotare la sala');
    expect(toInfinitive('Inviare il report')).toBe('Inviare il report');
    expect(toInfinitive('verbale da firmare')).toBe('Verbale da firmare');
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

  it('da Da smistare il task resta in Da smistare; scegliendo un progetto la conversazione lo segue', async () => {
    llm = () => ({ task: [{ titolo: 'Preparare il preventivo', scadenza: null }] });
    const a = await mail('a', 'Domanda', 'Mi prepari il preventivo?');
    await s.jobs.drain();
    const sugOf = (id: string) => new ConversationService(s.db).list({ view: 'inbox' }).find((c) => c.id === id)!.suggestions.find((x) => x.kind === 'task' && !x.payload.reply)!;
    s.suggestions.accept(sugOf(a.conversationId).id);
    expect(s.tasks.forProject(null).map((t) => t.title)).toEqual(['Preparare il preventivo']);
    expect(s.db.select().from(conversations).where(eq(conversations.id, a.conversationId)).get()!.projectId).toBeNull();

    const b = await mail('b', 'Altra domanda', 'Mi prepari il preventivo?');
    await s.jobs.drain();
    s.suggestions.accept(sugOf(b.conversationId).id, { projectId });
    expect(s.db.select().from(conversations).where(eq(conversations.id, b.conversationId)).get()!.projectId).toBe(projectId);
    expect(titles()).toEqual(['Preparare il preventivo']);
  });

  it('l\'assistente non propone il generico "rispondere"; "Ricordami di rispondere" crea il task di default', async () => {
    llm = () => ({ task: [{ titolo: 'Rispondere a Mario entro sera', scadenza: null }] }); // generico: scartato
    const r = await mail('a', 'Timesheet', 'Ciao, come va?');
    s.actions.move(r.conversationId, projectId);
    await s.jobs.drain();
    expect(new ConversationService(s.db).list({ view: 'project', projectId })[0]!.suggestions.filter((x) => x.kind === 'task')).toEqual([]);

    const t = s.tasks.remindReply(r.conversationId);
    expect(t).toMatchObject({ title: 'Rispondere a Mario — Timesheet', messageId: r.messageId, status: 'open' });
    expect(s.tasks.remindReply(r.conversationId).id).toBe(t.id); // uno solo aperto

    // Rispondo dall'app: il task si chiude da solo.
    s.actions.compose({ projectId, replyToMessageId: r.messageId!, to: ['mario@x.it'], cc: [], bcc: [], subject: '', body: 'Eccomi', urgent: false });
    expect(s.tasks.get(t.id)!.status).toBe('done');
  });

  it('niente estrazione da storico, rumore o posta inviata', async () => {
    await mail('old', 'Vecchia', 'fai questo', { date: 'Mon, 01 Jan 2024 10:00:00 +0100' });
    await mail('n', 'Offerte', 'compra', { noise: true });
    expect(s.db.select().from(jobs).all().filter((j) => j.kind === 'extract_tasks')).toHaveLength(0);
  });
});

describe('azioni rapide', () => {
  const actionLlm = (answer: object) => (system: string, user: string) => {
    if (system.includes('gestire la posta')) return answer;
    return system.includes('richieste esplicite') ? { task: [] } : { scelta: 'nessuno' };
  };
  const rebuild = (answer: object) => {
    const { db, sqlite } = openDb(':memory:');
    runMigrations(db);
    s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
      createProvider: () => {
        throw new Error('no imap');
      },
      summarizer: async () => ({ breve: 'x' }),
      embedder: async (texts) => texts.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
      llm: (async (system: string, user: string) => actionLlm(answer)(system, user)) as never,
    });
    accountId = s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;
    projectId = new ProjectService(db).create({ name: 'PNRR', outgoingAccountId: accountId }).id;
  };
  const actions = () => new ConversationService(s.db).list({ view: 'inbox' })[0]?.suggestions.filter((x) => x.kind === 'action') ?? [];

  it('propone "rispondi" con bozza; rispondere chiude suggerimenti e completa il task "Rispondere a…"', async () => {
    rebuild({ tipo: 'personale', azione: 'rispondere', bozza: 'Va bene, confermo per giovedì.', motivo: 'Chiede una conferma' });
    const r = await mail('a', 'Riunione', 'Confermi giovedì?');
    await s.jobs.drain();
    expect(actions().map((a) => [a.payload.action, a.payload.draft])).toEqual([['reply', 'Va bene, confermo per giovedì.']]);
    expect(() => s.suggestions.accept(actions()[0]!.id)).toThrow('compositore');

    // Il task "Rispondere a…" accettato si completa da solo quando rispondo.
    s.actions.move(r.conversationId, projectId);
    const task = s.tasks.remindReply(r.conversationId);
    expect(task.status).toBe('open');
    const msgId = s.db.select().from(messagesTable).where(eq(messagesTable.conversationId, r.conversationId)).get()!.id;
    s.actions.compose({ projectId, replyToMessageId: msgId, to: ['mario@x.it'], cc: [], bcc: [], subject: '', body: 'Confermo', urgent: false });
    expect(s.tasks.get(task.id)!.status).toBe('done');
    expect(new ConversationService(s.db).list({ view: 'project', projectId })[0]!.suggestions).toEqual([]);
  });

  it('propone "archivia" e "è rumore"; accettarli agisce sulla conversazione', async () => {
    rebuild({ tipo: 'personale', azione: 'archiviare', motivo: 'È solo un ringraziamento' });
    const r = await mail('a', 'Grazie', 'Grazie mille!');
    await s.jobs.drain();
    const res = s.suggestions.accept(actions()[0]!.id);
    expect(res.activityIds).toHaveLength(1);
    expect(s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!.archivedAt).not.toBeNull();

    rebuild({ tipo: 'automatica', azione: 'nessuna', motivo: 'Notifica automatica' });
    const n = await mail('b', 'Il tuo ordine', 'Il tuo ordine è stato spedito.');
    await s.jobs.drain();
    expect(actions()[0]!.payload.action).toBe('noise');
    s.suggestions.accept(actions()[0]!.id);
    expect(s.db.select().from(conversations).where(eq(conversations.id, n.conversationId)).get()!.isNoise).toBe(true);
  });
});
