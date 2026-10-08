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
    // Niente Ollama nei test: embedding e classificazione finti.
    embedder: async (texts) => texts.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
    llm: (async () => ({ scelta: 'nessuno', confidenza: 0 })) as never,
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

describe('contatti del progetto', () => {
  it('il progetto mostra solo contatti e gruppi inseriti esplicitamente', async () => {
    const r = await mail({ id: '<1@x>', from: 'Mario Rossi <mario@x.it>', to: 'me@gmail.com, Anna <anna@y.it>', subject: 'Budget', body: 'b' });
    s.actions.move(r.conversationId, projectId);
    expect(s.people.projectMembers(projectId)).toEqual({ contacts: [], groups: [] });

    const members = s.people.participantsToProject(r.conversationId, 'Team budget');
    expect(members.contacts).toEqual([]);
    expect(members.groups).toHaveLength(1);
    expect(members.groups[0]!.name).toBe('Team budget');
    expect(members.groups[0]!.members.map((m) => m.name).sort()).toEqual(['Anna', 'Mario Rossi']);
    // I partecipanti sono diventati contatti confermati.
    expect(s.people.directory().contacts.map((c) => c.name).sort()).toEqual(['Anna', 'Mario Rossi']);
  });

  it('con un solo destinatario lo aggiunge come contatto, riusando quello esistente', async () => {
    const r = await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'S', body: 'b' });
    const mario = s.people.createContact({ name: 'Mario', emails: ['mario@x.it'] });
    s.actions.move(r.conversationId, projectId);
    const members = s.people.participantsToProject(r.conversationId);
    expect(members.contacts.map((c) => c.contactId)).toEqual([mario.contactId]);
    expect(members.groups).toEqual([]);
  });

  it('rifiuta conversazioni fuori da un progetto', async () => {
    const r = await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'S', body: 'b' });
    expect(() => s.people.participantsToProject(r.conversationId)).toThrow('non è in un progetto');
  });
});

describe('unione dei contatti', () => {
  it('unisce due contatti: indirizzi, gruppi, progetti e foto passano al primo', async () => {
    await mail({ id: '<1@x>', from: 'luca@cnr.it', subject: 'A', body: 'b' });
    await mail({ id: '<2@x>', from: 'luca@gmail.com', subject: 'B', body: 'b' });
    const a = s.people.createContact({ name: 'Luca Sabatucci', emails: ['luca@cnr.it'] });
    const b = s.people.createContact({ name: 'Luca (personale)', emails: ['luca@gmail.com'] });
    s.people.setAvatar(b.contactId!, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const g = s.people.saveGroup(null, { name: 'Team', contactIds: [b.contactId!] });
    s.people.addToProject(projectId, { contactId: b.contactId! });

    const merged = s.people.merge(a.contactId!, b.key);
    expect(merged.name).toBe('Luca Sabatucci');
    expect(merged.emails.sort()).toEqual(['luca@cnr.it', 'luca@gmail.com']);
    expect(merged.avatarUrl).not.toBeNull();

    const dir = s.people.directory();
    expect(dir.contacts.map((c) => c.name)).toEqual(['Luca Sabatucci']);
    expect(dir.contacts[0]!.conversationCount).toBe(2);
    expect(dir.groups.find((x) => x.id === g)!.members.map((m) => m.contactId)).toEqual([a.contactId]);
    expect(s.people.projectMembers(projectId).contacts.map((c) => c.contactId)).toEqual([a.contactId]);
  });

  it('unire un indirizzo suggerito lo aggiunge al contatto', async () => {
    await mail({ id: '<1@x>', from: 'anna@y.it', subject: 'A', body: 'b' });
    const c = s.people.createContact({ name: 'Anna', emails: ['anna.bianchi@z.it'] });
    const suggested = s.people.directory().suggested[0]!;
    expect(s.people.merge(c.contactId!, suggested.key).emails.sort()).toEqual(['anna.bianchi@z.it', 'anna@y.it']);
    expect(s.people.directory().suggested).toHaveLength(0);
    expect(() => s.people.merge(c.contactId!, c.key)).toThrow('sé stesso');
  });
});

describe('foto dei contatti', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  it('accetta solo immagini vere e le espone con un URL che cambia con la foto', () => {
    const c = s.people.createContact({ name: 'Mario', emails: ['mario@x.it'] });
    expect(() => s.people.setAvatar(c.contactId!, Buffer.from('<svg onload=alert(1)>'))).toThrow('Formato non supportato');
    const withPhoto = s.people.setAvatar(c.contactId!, png);
    expect(withPhoto.avatarUrl).toMatch(new RegExp(`^/api/contacts/${c.contactId}/avatar\\?v=[0-9a-f]{12}$`));
    expect(s.people.avatar(c.contactId!)).toMatchObject({ mime: 'image/png' });
    expect(s.people.directory().contacts[0]!.avatarUrl).toBe(withPhoto.avatarUrl);
    expect(s.people.setAvatar(c.contactId!, null).avatarUrl).toBeNull();
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

describe('conteggio allegati', () => {
  it('conta solo gli allegati della propria conversazione', async () => {
    const withAtt = (id: string, subject: string) =>
      Buffer.from(
        [
          `Message-ID: ${id}`, 'From: mario@x.it', 'To: me@gmail.com', `Subject: ${subject}`,
          'Date: Wed, 07 Oct 2026 10:00:00 +0200', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '',
          '--B', 'Content-Type: text/plain', '', 'vedi allegato', '--B',
          'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '',
          'JVBERg==', '--B--', '',
        ].join('\r\n'),
      );
    const ing = (src: Buffer) => ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, { uid: uid++, mailbox: 'All', source: src, flags: [], labels: [] });
    await ing(withAtt('<a1@x>', 'Uno'));
    await ing(withAtt('<a2@x>', 'Due'));
    const list = new ConversationService(s.db).list({ view: 'inbox' });
    expect(list.map((c) => c.attachmentCount)).toEqual([1, 1]);
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
    const summaryJobs = () => s.db.select().from(jobs).all().filter((j) => j.kind === 'summarize');
    expect(summaryJobs().map((j) => JSON.parse(j.payload).conversationId)).toEqual([r.conversationId]);

    await s.jobs.drain();
    expect(prompts[0]).toContain('Mario:\nCi vediamo giovedì?');
    const conv = s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!;
    expect(conv.summary).toBe('Mario propone una riunione giovedì.');
    expect(conv.summaryDetailed).toContain('Da confermare');
    expect(summaryJobs()).toHaveLength(0);
  });

  it('non duplica i lavori in attesa per la stessa conversazione', async () => {
    const r = await mail({ id: '<1@x>', from: 'mario@x.it', subject: 'S', body: 'a' });
    await mail({ id: '<2@x>', from: 'anna@y.it', subject: 'Re: S', body: 'b', inReplyTo: '<1@x>', refs: ['<1@x>'] });
    expect(s.db.select().from(jobs).all().filter((j) => j.kind === 'summarize')).toHaveLength(1);
    expect(buildSummaryPrompt(s.db, r.conversationId)).toContain('anna@y.it:\nb');
  });
});
