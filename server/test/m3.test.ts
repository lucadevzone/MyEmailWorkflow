import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage } from '../src/ingest/ingest.ts';
import { ConversationService, buildTree } from '../src/conversations/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { conversations, jobs } from '../src/db/schema.ts';
import { buildSummaryPrompt } from '../src/ai/summarize.ts';

let s: ReturnType<typeof buildServices>;
let accountId: string;
let projectId: string;
let prompts: string[];

function eml(o: { id: string; from: string; to?: string; subject: string; body: string; inReplyTo?: string; refs?: string[] }) {
  return Buffer.from(
    [
      `Message-ID: ${o.id}`,
      `From: ${o.from}`,
      `To: ${o.to ?? 'me@gmail.com'}`,
      `Subject: ${o.subject}`,
      'Date: Wed, 07 Oct 2026 10:00:00 +0200',
      o.inReplyTo && `In-Reply-To: ${o.inReplyTo}`,
      o.refs && `References: ${o.refs.join(' ')}`,
      'Content-Type: text/plain; charset=utf-8',
    ]
      .filter(Boolean)
      .join('\r\n') + `\r\n\r\n${o.body}`,
  );
}

let uid = 1;
const mail = (o: Parameters<typeof eml>[0]) =>
  ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
    uid: uid++, mailbox: 'All', source: eml(o), flags: [], labels: [], gmMsgid: `g${uid}`, gmThreadId: null,
  });

beforeEach(() => {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  prompts = [];
  s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
    createProvider: () => {
      throw new Error('no imap');
    },
    summarizer: async (prompt) => {
      prompts.push(prompt);
      return { breve: 'Mario propone una riunione giovedì.', dettagliata: 'Mario chiede di vedersi giovedì. Da confermare.' };
    },
  });
  accountId = s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;
  projectId = new ProjectService(db).create({ name: 'PNRR', outgoingAccountId: accountId }).id;
});

describe('persone', () => {
  it('elenca le persone di un progetto (escluso me) e quelle aggiunte a mano', async () => {
    const a = await mail({ id: '<1@x>', from: 'Mario Rossi <mario@x.it>', to: 'me@gmail.com, anna@y.it', subject: 'S', body: 'b' });
    s.actions.move(a.conversationId, projectId);
    s.people.addToProject(projectId, { name: 'Giulia', email: 'giulia@z.it' });

    const people = s.people.inScope({ view: 'project', projectId });
    expect(people.map((p) => p.emails[0]).sort()).toEqual(['anna@y.it', 'giulia@z.it', 'mario@x.it']);
    expect(people.find((p) => p.emails[0] === 'giulia@z.it')).toMatchObject({ member: true, name: 'Giulia', conversationCount: 0 });
  });

  it('un contatto con due indirizzi è una sola persona e filtra le conversazioni di entrambi', async () => {
    const a = await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'Uno', body: 'b' });
    const b = await mail({ id: '<2@x>', from: 'mario.rossi@altro.it', subject: 'Due', body: 'b' });
    await mail({ id: '<3@x>', from: 'anna@y.it', subject: 'Tre', body: 'b' });
    const mario = s.people.createContact({ name: 'Mario Rossi', emails: ['mario@x.it', 'mario.rossi@altro.it'] });

    const inbox = s.people.inScope({ view: 'inbox' });
    expect(inbox.find((p) => p.contactId === mario.contactId)).toMatchObject({ conversationCount: 2, name: 'Mario Rossi' });

    const convs = new ConversationService(s.db).list({ view: 'person', person: mario.key, personAddressIds: s.people.addressIdsFor(mario.key) });
    expect(convs.map((c) => c.id).sort()).toEqual([a.conversationId, b.conversationId].sort());
  });

  it('directory: contatti confermati, suggeriti e gruppi', async () => {
    await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'S', body: 'b' });
    await mail({ id: '<2@x>', from: 'anna@y.it', subject: 'S', body: 'b' });
    const mario = s.people.createContact({ name: 'Mario', emails: ['mario@x.it'] });
    s.people.saveGroup(null, { name: 'Team', contactIds: [mario.contactId!] });
    const dir = s.people.directory();
    expect(dir.contacts.map((c) => c.name)).toEqual(['Mario']);
    expect(dir.suggested.map((p) => p.emails[0])).toEqual(['anna@y.it']);
    expect(dir.groups).toMatchObject([{ name: 'Team', members: [{ name: 'Mario' }] }]);
  });

  it('suggerisce il progetto in base alle conversazioni con quella persona', async () => {
    const other = new ProjectService(s.db).create({ name: 'Corso', outgoingAccountId: accountId }).id;
    for (const [i, p] of [[1, projectId], [2, projectId], [3, other]] as const) {
      const r = await mail({ id: `<${i}@x>`, from: 'mario@x.it', subject: `S${i}`, body: 'b' });
      s.actions.move(r.conversationId, p);
    }
    expect(s.people.suggestProjects(['Mario@x.it']).map((p) => [p.name, p.conversations])).toEqual([
      ['PNRR', 2],
      ['Corso', 1],
    ]);
  });
});

describe('note e risorse', () => {
  it('conta note e risorse nella lista e le restituisce nel dettaglio', async () => {
    const r = await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'S', body: 'b' });
    s.notes.createNote({ conversationId: r.conversationId, body: 'Ricordarsi il budget' });
    const res = s.notes.addFile({ conversationId: r.conversationId }, 'piano.pdf', Buffer.from('%PDF'), 'application/pdf');
    const conv = new ConversationService(s.db);
    expect(conv.list({ view: 'inbox' })[0]).toMatchObject({ noteCount: 1, resourceCount: 1 });
    const detail = conv.get(r.conversationId)!;
    expect(detail.notes[0]!.body).toBe('Ricordarsi il budget');
    expect(detail.resources[0]).toMatchObject({ title: 'piano.pdf', size: 4 });
    s.notes.deleteResource(res.id);
    expect(conv.list({ view: 'inbox' })[0]!.resourceCount).toBe(0);
  });

  it('note e risorse seguono la conversazione quando la si sposta', async () => {
    const r = await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'S', body: 'b' });
    const note = s.notes.createNote({ conversationId: r.conversationId, body: 'x' });
    expect(note.projectId).toBeNull();
    s.actions.move(r.conversationId, projectId);
    expect(new ConversationService(s.db).get(r.conversationId)!.notes[0]!.projectId).toBe(projectId);
  });
});

describe('albero dei messaggi', () => {
  it('ricostruisce chi risponde a chi; senza riferimenti si aggancia alla radice', () => {
    const tree = buildTree([
      { id: 'a', rfcMessageId: '<a>', inReplyTo: null, references: '[]' },
      { id: 'b', rfcMessageId: '<b>', inReplyTo: '<a>', references: '["<a>"]' },
      { id: 'c', rfcMessageId: '<c>', inReplyTo: '<a>', references: '["<a>"]' },
      { id: 'd', rfcMessageId: '<d>', inReplyTo: '<b>', references: '["<a>","<b>"]' },
      { id: 'e', rfcMessageId: '<e>', inReplyTo: null, references: '[]' },
    ]);
    expect(Object.fromEntries(tree)).toEqual({ a: null, b: 'a', c: 'a', d: 'b', e: 'a' });
  });
});

describe('sintesi', () => {
  it('ogni nuovo messaggio accoda la sintesi (non per il rumore) e il job la salva', async () => {
    const r = await mail({ id: '<1@x>', from: 'Mario <mario@x.it>', subject: 'Riunione', body: 'Ci vediamo giovedì?' });
    await mail({ id: '<n@x>', from: 'news@shop.it', subject: 'Offerte', body: 'saldi' });
    expect(s.db.select().from(jobs).all().map((j) => JSON.parse(j.payload).conversationId)).toEqual([r.conversationId]);

    await s.jobs.drain();
    expect(prompts[0]).toContain('Mario:\nCi vediamo giovedì?');
    const conv = s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!;
    expect(conv.summary).toBe('Mario propone una riunione giovedì.');
    expect(conv.summaryDetailed).toContain('Da confermare');
    expect(s.db.select().from(jobs).all()).toHaveLength(0);
  });

  it('non duplica i lavori in attesa per la stessa conversazione', async () => {
    const r = await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'S', body: 'a' });
    await mail({ id: '<2@x>', from: 'anna@y.it', subject: 'Re: S', body: 'b', inReplyTo: '<1@x>', refs: ['<1@x>'] });
    expect(s.db.select().from(jobs).all()).toHaveLength(1);
    expect(buildSummaryPrompt(s.db, r.conversationId)).toContain('anna@y.it:\nb');
  });
});
