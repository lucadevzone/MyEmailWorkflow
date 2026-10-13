import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage, updateFlags } from '../src/ingest/ingest.ts';
import { ConversationService } from '../src/conversations/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { conversations, messages } from '../src/db/schema.ts';
import { buildApp } from '../src/app.ts';
import type { MailProviderClient } from '../src/mail/provider.ts';

// ─── Server di posta e SMTP finti ────────────────────────────────────────────

type Call = { op: string; mailbox?: string; uids?: number[]; flags?: string[] };

function fakeProvider(calls: Call[]): MailProviderClient {
  const unsupported = () => {
    throw new Error('non usato nei test');
  };
  return {
    connect: async () => {},
    close: async () => {},
    capabilities: () => ['X-GM-EXT-1'],
    isGmail: () => true,
    listMailboxes: unsupported,
    syncMailbox: unsupported,
    openMailbox: unsupported,
    searchUidsSince: unsupported,
    searchUidRange: unsupported,
    fetchUids: unsupported,
    fetchFlagsChangedSince: unsupported,
    on: () => () => {},
    addFlags: async (mailbox, uids, flags) => void calls.push({ op: 'addFlags', mailbox, uids, flags }),
    removeFlags: async (mailbox, uids, flags) => void calls.push({ op: 'removeFlags', mailbox, uids, flags }),
    moveToTrash: async (mailbox, uids) => void calls.push({ op: 'trash', mailbox, uids }),
    moveToSpam: async (mailbox, uids) => void calls.push({ op: 'spam', mailbox, uids }),
    archive: async (mailbox, uids) => void calls.push({ op: 'archive', mailbox, uids }),
    appendToSent: async () => void calls.push({ op: 'appendToSent' }),
  };
}

let s: ReturnType<typeof buildServices>;
let calls: Call[];
let sent: { raw: string; to: string[] }[];
let smtpFails: boolean;
let accountId: string;
let projectId: string;
const conv = () => new ConversationService(s.db);

function eml(o: { id: string; from: string; subject: string; body: string; inReplyTo?: string }) {
  return Buffer.from(
    [
      `Message-ID: ${o.id}`,
      `From: ${o.from}`,
      'To: me@gmail.com',
      `Subject: ${o.subject}`,
      'Date: Wed, 07 Oct 2026 10:00:00 +0200',
      o.inReplyTo && `In-Reply-To: ${o.inReplyTo}`,
      'Content-Type: text/plain; charset=utf-8',
    ]
      .filter(Boolean)
      .join('\r\n') + `\r\n\r\n${o.body}`,
  );
}

async function incoming(id: string, uid: number, extra: { gmThreadId?: string; from?: string; subject?: string } = {}) {
  return ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
    uid,
    mailbox: '[Gmail]/Tutti i messaggi',
    source: eml({ id, from: extra.from ?? 'mario@x.it', subject: extra.subject ?? 'Riunione', body: 'Ci vediamo?' }),
    flags: [],
    labels: ['\\Inbox'],
    gmMsgid: `gm-${uid}`,
    gmThreadId: extra.gmThreadId ?? `t-${uid}`,
  });
}

beforeEach(() => {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  calls = [];
  sent = [];
  smtpFails = false;
  s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
    createProvider: () => fakeProvider(calls),
    sendSmtp: async (_account, raw, envelope) => {
      if (smtpFails) throw new Error('SMTP non raggiungibile');
      sent.push({ raw: raw.toString('utf8'), to: envelope.to });
    },
  });
  accountId = s.accounts.create({ name: 'Prova', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;
  projectId = new ProjectService(db).create({ name: 'PNRR', outgoingAccountId: accountId }).id;
});

// ─── Test ────────────────────────────────────────────────────────────────────

describe('progetti e spostamenti', () => {
  it('sposta una conversazione da Da smistare a un progetto e ritorno', async () => {
    const { conversationId } = await incoming('<1@x>', 1);
    const res = s.actions.move(conversationId, projectId);
    expect(res.previousProjectId).toBeNull();
    expect(conv().list({ view: 'inbox' })).toHaveLength(0);
    expect(conv().list({ view: 'project', projectId }).map((c) => c.id)).toEqual([conversationId]);
    expect(new ProjectService(s.db).get(projectId)!.conversationCount).toBe(1);

    s.actions.move(conversationId, null);
    expect(conv().list({ view: 'inbox' })).toHaveLength(1);
  });

  it('i nuovi messaggi di una conversazione assegnata restano nel progetto', async () => {
    const { conversationId } = await incoming('<1@x>', 1, { gmThreadId: 'T' });
    s.actions.move(conversationId, projectId);
    const reply = await incoming('<2@x>', 2, { gmThreadId: 'T' });
    expect(reply.conversationId).toBe(conversationId);
    expect(conv().list({ view: 'project', projectId })[0]!.messageCount).toBe(2);
  });

  it('rimuovendo un progetto le conversazioni tornano in Da smistare; con "archivia tutto" le aperte vengono archiviate', async () => {
    const app = buildApp({ ...s, port: 4310 });
    const headers = { host: '127.0.0.1:4310', 'x-mmw': '1', 'content-type': 'application/json' };
    const projects = new ProjectService(s.db);
    const a = (await incoming('<1@x>', 1)).conversationId;
    const b = (await incoming('<2@x>', 2)).conversationId;
    s.actions.move(a, projectId);
    s.actions.move(b, projectId);
    s.actions.archive(b);
    expect(projects.get(projectId)).toMatchObject({ conversationCount: 1, archivedConversationCount: 1 });

    let res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/remove`, headers, payload: {} });
    expect(res.json()).toMatchObject({ movedConversations: 2, archived: 0 });
    expect(conv().list({ view: 'inbox' }).map((c) => c.id)).toEqual([a]);
    expect(conv().list({ view: 'inbox', archived: true }).map((c) => c.id)).toEqual([b]);

    const other = projects.create({ name: 'Altro', outgoingAccountId: accountId }).id;
    s.actions.move(a, other);
    res = await app.inject({ method: 'POST', url: `/api/projects/${other}/remove`, headers, payload: { archiveOpen: true } });
    expect(res.json()).toMatchObject({ movedConversations: 1, archived: 1 });
    expect(conv().list({ view: 'inbox' })).toHaveLength(0);
    expect(conv().list({ view: 'inbox', archived: true }).map((c) => c.id).sort()).toEqual([a, b].sort());
    await app.close();
  });
});

describe('unione di conversazioni scelte', () => {
  it('unisce messaggi e task nella conversazione nata per prima; solo nello stesso progetto', async () => {
    const a = (await incoming('<a@x>', 1, { subject: 'Riunione WP5' })).conversationId;
    const b = (await incoming('<b@x>', 2, { subject: 'Agenda WP5' })).conversationId;
    const c = (await incoming('<c@x>', 3, { subject: 'Altro' })).conversationId;
    s.tasks.create({ projectId: null, title: 'Preparare le slide', conversationId: b });
    s.actions.archive(b);
    s.actions.move(c, projectId);
    expect(() => s.actions.merge([a])).toThrow('almeno due');
    expect(() => s.actions.merge([a, c])).toThrow('stesso progetto');

    const r = s.actions.merge([b, a]);
    expect(r.conversationId).toBe(a);
    const merged = conv().get(a)!;
    expect(merged.messages).toHaveLength(2);
    expect(merged.archived).toBe(false); // una era aperta
    expect(s.tasks.forConversation(a).map((t) => t.title)).toEqual(['Preparare le slide']);
    expect(conv().item(b)).toBeUndefined();
  });
});

describe('importanti e ricerca persone', () => {
  it('la vista Importanti mostra attive e archiviate con un messaggio importante; la ricerca trova ogni indirizzo visto', async () => {
    const a = await incoming('<1@x>', 1, { from: 'Studio Barone <info@studio.it>' });
    const b = await incoming('<2@x>', 2);
    await incoming('<3@x>', 3);
    conv().setImportant([a.messageId, b.messageId], true);
    s.actions.archive(b.conversationId);
    expect(conv().list({ view: 'inbox', important: true }).map((c) => c.id).sort()).toEqual([a.conversationId, b.conversationId].sort());
    expect(conv().importantCounts()).toEqual({ inbox: 2 });
    expect(s.people.search('baro').map((p) => p.name)).toEqual(['Studio Barone']);
    expect(s.people.search('mario@x').map((p) => p.emails[0])).toEqual(['mario@x.it']);
    expect(s.people.search('zzz')).toHaveLength(0);
  });
});

describe('letto / non letto', () => {
  it('segna come letto subito e propaga a Gmail al batch', async () => {
    const { conversationId, messageId } = await incoming('<1@x>', 7);
    const [activityId] = s.actions.markRead(conversationId);
    expect(conv().list({ view: 'inbox' })[0]!.unreadCount).toBe(0);
    expect(s.activities.get(activityId!)!.status).toBe('pending');
    expect(calls).toHaveLength(0);

    await s.runner.run();
    expect(calls).toEqual([{ op: 'addFlags', mailbox: '[Gmail]/Tutti i messaggi', uids: [7], flags: ['\\Seen'] }]);
    expect(s.activities.get(activityId!)!.status).toBe('done');
    expect(s.db.select().from(messages).where(eq(messages.id, messageId)).get()!.seen).toBe(true);
  });

  it('aprire un singolo messaggio segna letto solo quello', async () => {
    const a = await incoming('<1@x>', 7, { gmThreadId: 'T' });
    await incoming('<2@x>', 8, { gmThreadId: 'T' });
    s.actions.markMessageRead(a.messageId);
    expect(conv().list({ view: 'inbox' })[0]!.unreadCount).toBe(1);
    await s.runner.run();
    expect(calls).toEqual([{ op: 'addFlags', mailbox: '[Gmail]/Tutti i messaggi', uids: [7], flags: ['\\Seen'] }]);
  });

  it('segna tutto come letto in una vista con un\'attività per account, annullabile', async () => {
    await incoming('<1@x>', 7);
    await incoming('<2@x>', 8);
    const res = s.actions.markViewRead({ view: 'inbox' });
    expect(res.count).toBe(2);
    expect(res.activityIds).toHaveLength(1);
    expect(conv().list({ view: 'inbox' }).every((c) => c.unreadCount === 0)).toBe(true);
    s.activities.cancel(res.activityIds[0]!);
    expect(conv().list({ view: 'inbox' }).every((c) => c.unreadCount === 1)).toBe(true);
    s.actions.markViewRead({ view: 'inbox' });
    await s.runner.run();
    expect(calls).toEqual([{ op: 'addFlags', mailbox: '[Gmail]/Tutti i messaggi', uids: [7, 8], flags: ['\\Seen'] }]);
  });

  it('annullare ripristina il non letto', async () => {
    const { conversationId } = await incoming('<1@x>', 7);
    const [activityId] = s.actions.markRead(conversationId);
    s.activities.cancel(activityId!);
    expect(conv().list({ view: 'inbox' })[0]!.unreadCount).toBe(1);
    await s.runner.run();
    expect(calls).toHaveLength(0);
  });

  it('il sync non sovrascrive un "letto" ancora in coda', async () => {
    const { conversationId, messageId } = await incoming('<1@x>', 7);
    s.actions.markRead(conversationId);
    // Il server riporta ancora il messaggio come non letto (es. evento per un cambio di etichetta).
    updateFlags(s.db, messageId, { flags: [], labels: ['\\Inbox', 'Altro'], uid: 7, mailbox: '[Gmail]/Tutti i messaggi', gmMsgid: 'gm-7' });
    expect(s.db.select().from(messages).where(eq(messages.id, messageId)).get()!.seen).toBe(true);
  });
});

describe('archivio e cestino', () => {
  it('archivia: sparisce subito, su Gmail toglie Inbox al batch; annullabile', async () => {
    const { conversationId } = await incoming('<1@x>', 3);
    const [a] = s.actions.archive(conversationId);
    expect(conv().list({ view: 'inbox' })).toHaveLength(0);
    expect(conv().list({ view: 'inbox', archived: true })).toHaveLength(1);
    s.activities.cancel(a!);
    expect(conv().list({ view: 'inbox' })).toHaveLength(1);

    s.actions.archive(conversationId);
    await s.runner.run();
    expect(calls).toEqual([{ op: 'archive', mailbox: '[Gmail]/Tutti i messaggi', uids: [3] }]);
  });

  it('cestina e la riporta in vista se arriva una risposta', async () => {
    const { conversationId } = await incoming('<1@x>', 3, { gmThreadId: 'T' });
    s.actions.trash(conversationId);
    await s.runner.run();
    expect(calls).toEqual([{ op: 'trash', mailbox: '[Gmail]/Tutti i messaggi', uids: [3] }]);
    expect(conv().list({ view: 'inbox' })).toHaveLength(0);
    await incoming('<2@x>', 4, { gmThreadId: 'T' });
    expect(conv().list({ view: 'inbox' })).toHaveLength(1);
  });
});

describe('composizione e invio', () => {
  it('nuova email da progetto: in coda, poi inviata e riconciliata con la copia di Gmail', async () => {
    const r = s.actions.compose({ projectId, to: ['anna@y.it'], cc: [], bcc: ['nascosto@z.it'], subject: 'Report', body: 'In allegato…', urgent: false });
    const msg = () => s.db.select().from(messages).where(eq(messages.id, r.messageId)).get()!;
    expect(msg().outgoingStatus).toBe('queued');
    expect(conv().list({ view: 'project', projectId }).map((c) => c.id)).toEqual([r.conversationId]);

    await s.runner.run();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['anna@y.it', 'nascosto@z.it']);
    expect(sent[0]!.raw).toContain(`Message-ID: ${msg().rfcMessageId}`);
    expect(sent[0]!.raw).toContain('From: Prova <me@gmail.com>');
    expect(sent[0]!.raw).not.toMatch(/^Bcc:/im);
    expect(msg().outgoingStatus).toBe('sent');

    // Il sync ritrova l'inviata in "Tutti i messaggi": niente duplicati, UID e thread agganciati.
    const copy = await ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
      uid: 99, mailbox: '[Gmail]/Tutti i messaggi',
      source: Buffer.from(sent[0]!.raw), flags: ['\\Seen'], labels: ['\\Sent'], gmMsgid: 'gm-99', gmThreadId: 'T-new',
    });
    expect(copy).toMatchObject({ messageId: r.messageId, created: false });
    expect(msg().uid).toBe(99);
    expect(s.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!.gmThreadId).toBe('T-new');
  });

  it('risposta da Da smistare: porta la conversazione nel progetto e imposta i riferimenti', async () => {
    const { conversationId, messageId } = await incoming('<orig@x>', 5);
    const r = s.actions.compose({ projectId, replyToMessageId: messageId, to: ['mario@x.it'], cc: [], bcc: [], subject: '', body: 'Sì!', urgent: false });
    expect(r.conversationId).toBe(conversationId);
    expect(conv().list({ view: 'inbox' })).toHaveLength(0);
    await s.runner.run();
    expect(sent[0]!.raw).toContain('In-Reply-To: <orig@x>');
    expect(sent[0]!.raw).toContain('Subject: Re: Riunione');
  });

  it("urgente: parte subito senza aspettare il batch", async () => {
    s.actions.compose({ projectId, to: ['a@b.it'], cc: [], bcc: [], subject: 'Subito', body: '!', urgent: true });
    await s.runner.run([]); // attende la catena di esecuzione già avviata
    expect(sent).toHaveLength(1);
  });

  it("annullare un invio toglie il messaggio e la conversazione creata", async () => {
    const r = s.actions.compose({ projectId, to: ['a@b.it'], cc: [], bcc: [], subject: 'Ops', body: 'x', urgent: false });
    s.activities.cancel(r.activityId);
    expect(conv().list({ view: 'project', projectId })).toHaveLength(0);
    await s.runner.run();
    expect(sent).toHaveLength(0);
  });

  it('invio fallito: resta visibile con errore e si può ritentare', async () => {
    smtpFails = true;
    const r = s.actions.compose({ projectId, to: ['a@b.it'], cc: [], bcc: [], subject: 'X', body: 'x', urgent: false });
    await s.runner.run();
    expect(s.activities.get(r.activityId)!).toMatchObject({ status: 'failed', lastError: 'SMTP non raggiungibile' });
    expect(s.db.select().from(messages).where(eq(messages.id, r.messageId)).get()!.outgoingStatus).toBe('failed');

    smtpFails = false;
    s.activities.retry(r.activityId);
    await s.runner.run();
    expect(s.activities.get(r.activityId)!.status).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('non si può scrivere senza progetto valido', () => {
    expect(() => s.actions.compose({ projectId: 'nope', to: ['a@b.it'], cc: [], bcc: [], subject: '', body: '', urgent: false })).toThrow(
      'Progetto non trovato',
    );
  });
});

describe('importante', () => {
  it('segna subito nell\'app e invia \\Flagged a Gmail al batch; annullare ripristina', async () => {
    const { conversationId, messageId } = await incoming('<imp@x>', 20);
    const ids = s.actions.setImportant(messageId, true);
    expect(conv().get(conversationId)!.messages[0]!.important).toBe(true);
    expect(conv().list({ view: 'inbox' })[0]!.important).toBe(true);
    s.activities.cancel(ids[0]!);
    expect(conv().get(conversationId)!.messages[0]!.important).toBe(false);
    s.actions.setImportant(messageId, true);
    await s.runner.run();
    expect(calls).toContainEqual(expect.objectContaining({ op: 'addFlags', uids: [20], flags: ['\\Flagged'] }));
  });

  it('il flag arrivato dal server si riflette, ma non sovrascrive un\'intenzione in coda', async () => {
    const { conversationId, messageId } = await incoming('<imp2@x>', 21);
    const msg = () => conv().get(conversationId)!.messages[0]!;
    updateFlags(s.db, messageId, { flags: ['\\Flagged'], labels: ['\\Inbox'], uid: 21, mailbox: '[Gmail]/Tutti i messaggi', gmMsgid: 'gm-21' });
    expect(msg().important).toBe(true);
    s.actions.setImportant(messageId, false);
    updateFlags(s.db, messageId, { flags: ['\\Flagged'], labels: ['\\Inbox'], uid: 21, mailbox: '[Gmail]/Tutti i messaggi', gmMsgid: 'gm-21' });
    expect(msg().important).toBe(false);
  });
});

describe('bozze, allegati, inoltro', () => {
  it('bozza di risposta: indicatore sulla conversazione, testo citato e allegati all\'invio', async () => {
    const { conversationId, messageId } = await incoming('<q@x>', 30);
    const d = s.drafts.create({ projectId, conversationId, replyToMessageId: messageId, to: ['mario@x.it'] });
    expect(conv().list({ view: 'inbox' })[0]!.hasDraft).toBe(true);
    s.drafts.update(d.id, { body: 'Va bene.', includeQuote: true });
    const withFile = s.drafts.addFile(d.id, 'nota.txt', Buffer.from('contenuto allegato'), 'text/plain');
    expect(withFile.attachments).toHaveLength(1);

    const r = s.drafts.send(d.id, false);
    expect(() => s.drafts.get(d.id)).toThrow();
    expect(r.conversationId).toBe(conversationId);
    const out = conv().get(conversationId)!.messages.find((m) => m.id === r.messageId)!;
    expect(out.attachments.map((a) => a.filename)).toEqual(['nota.txt']);
    await s.runner.run();
    expect(sent[0]!.raw).toContain('ha scritto:');
    expect(sent[0]!.raw).toContain('> Ci vediamo?');
    expect(sent[0]!.raw).toMatch(/filename="?nota\.txt/);
    expect(sent[0]!.raw).toContain(Buffer.from('contenuto allegato').toString('base64'));
  });

  it('inoltro: nuova conversazione, oggetto Fwd: e testo originale', async () => {
    const { conversationId, messageId } = await incoming('<f@x>', 31);
    const r = s.actions.compose({ projectId, forwardMessageId: messageId, to: ['anna@y.it'], body: 'Guarda qui', urgent: false });
    expect(r.conversationId).not.toBe(conversationId);
    await s.runner.run();
    expect(sent[0]!.raw).toContain('Subject: Fwd: Riunione');
    expect(sent[0]!.raw).toContain('Messaggio inoltrato');
    expect(sent[0]!.raw).toContain('Ci vediamo?');
  });

  it('blocca invio: la risposta in coda torna bozza con testo e allegati, e non parte', async () => {
    const { conversationId, messageId } = await incoming('<b@x>', 31);
    const d = s.drafts.create({ projectId, conversationId, replyToMessageId: messageId, to: ['mario@x.it'], subject: 'Re: Ci vediamo?' });
    s.drafts.update(d.id, { body: 'Confermo giovedì.', includeQuote: true });
    s.drafts.addFile(d.id, 'nota.txt', Buffer.from('contenuto'), 'text/plain');
    const r = s.drafts.send(d.id, false);

    const back = s.drafts.blockSend(r.activityId);
    expect(back).toMatchObject({ conversationId, replyToMessageId: messageId, to: ['mario@x.it'], subject: 'Re: Ci vediamo?', body: 'Confermo giovedì.', includeQuote: true });
    expect(back.attachments.map((a) => [a.filename, a.size])).toEqual([['nota.txt', 9]]);
    expect(conv().get(conversationId)!.messages.some((m) => m.id === r.messageId)).toBe(false);
    expect(s.activities.get(r.activityId)!.status).toBe('cancelled');
    await s.runner.run();
    expect(sent).toHaveLength(0);
    // Troppo tardi: un invio già annullato (o partito) non si blocca più.
    expect(() => s.drafts.blockSend(r.activityId)).toThrow();
  });

  it('blocca invio di una mail nuova: sparisce la conversazione, resta la bozza senza conversazione', () => {
    const d = s.drafts.create({ projectId, to: ['a@b.it'], subject: 'Proposta', body: 'Ciao' });
    const r = s.drafts.send(d.id, false);
    expect(s.activities.sendFor(r.messageId)?.id).toBe(r.activityId);
    const back = s.drafts.blockSend(r.activityId);
    expect(back).toMatchObject({ projectId, conversationId: null, subject: 'Proposta', body: 'Ciao' });
    expect(conv().get(r.conversationId)).toBeUndefined();
  });

  it('bozza HTML: parte testo + HTML nel carattere scelto, con la citazione in blockquote; blocca invio la riporta HTML', async () => {
    s.settings.update({ composeFont: 'serif', composeFontSize: 'large' });
    const { conversationId, messageId } = await incoming('<h@x>', 40);
    const d = s.drafts.create({ projectId, conversationId, replyToMessageId: messageId, to: ['mario@x.it'], format: 'html' });
    s.drafts.update(d.id, { body: 'Va bene, a giovedì.', bodyHtml: '<p>Va <strong>bene</strong>, a giovedì.</p>', includeQuote: true });
    const r = s.drafts.send(d.id, false);
    const out = conv().get(conversationId)!.messages.find((m) => m.id === r.messageId)!;
    expect(out.hasHtml).toBe(true);

    const back = s.drafts.blockSend(r.activityId);
    expect(back).toMatchObject({ format: 'html', bodyHtml: '<p>Va <strong>bene</strong>, a giovedì.</p>', body: 'Va bene, a giovedì.' });
    s.drafts.send(back.id, false);
    await s.runner.run();
    const raw = sent[0]!.raw;
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
    expect(raw).toMatch(/Georgia/);
    expect(raw).toMatch(/18px/);
    expect(raw).toMatch(/<strong>bene<\/strong>/);
    expect(raw).toMatch(/blockquote/);
  });

  it('bozza senza progetto non si invia', () => {
    const d = s.drafts.create({ to: ['a@b.it'] });
    expect(() => s.drafts.send(d.id, false)).toThrow(/progetto/);
  });
});

describe('spam', () => {
  it('È spam: sparisce subito, al batch va nella cartella Spam; annullabile', async () => {
    const { conversationId } = await incoming('<sp@x>', 600);
    const [a] = s.actions.markSpam(conversationId);
    expect(conv().list({ view: 'inbox' })).toHaveLength(0);
    s.activities.cancel(a!);
    expect(conv().list({ view: 'inbox' })).toHaveLength(1);
    s.actions.markSpam(conversationId);
    await s.runner.run();
    expect(calls).toEqual([{ op: 'spam', mailbox: '[Gmail]/Tutti i messaggi', uids: [600] }]);
  });
});

describe('manutenzione retroattiva', () => {
  it('corregge date assurde, archivia ciò che è archiviato su Gmail, ricalcola le News (non quelle decise a mano); una volta sola', async () => {
    const { runRepairs } = await import('../src/maintenance/repair.ts');
    const src = (id: string, extra: string, subject = 'Ciao') =>
      Buffer.from(`Message-ID: <${id}@x>\r\nReceived: from mx by gmail; Wed, 01 Oct 2026 10:00:00 +0000\r\nFrom: fatture@vodafone.it\r\nTo: me@gmail.com\r\nSubject: ${subject}\r\nDate: Wed, 01 Oct 2026 10:00:00 +0000\r\n${extra}\r\nciao`);
    const ing = (id: string, n: number, extra: string, labels: string[], subject?: string) =>
      ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, { uid: n, mailbox: '[Gmail]/Tutti i messaggi', source: src(id, extra, subject), flags: [], labels, gmMsgid: `gm-${n}`, gmThreadId: `t-${n}` });
    const fattura = await ing('f', 700, 'Feedback-ID: x:y:z\r\n', ['\\Inbox'], 'Emissione fattura Vodafone');
    const manual = await ing('m', 701, 'Feedback-ID: x:y:z\r\n', ['\\Inbox'], 'Emissione fattura');
    const old = await ing('o', 702, '', ['\\Inbox']);
    const row = (id: string) => s.db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    // Stato lasciato dalla versione precedente: fattura nelle News, data falsa, etichetta Inbox tolta.
    s.sqlite.prepare('update conversations set is_noise = 1 where id in (?, ?)').run(fattura.conversationId, manual.conversationId);
    s.sqlite.prepare('update conversations set noise_manual = 1 where id = ?').run(manual.conversationId);
    s.sqlite.prepare('update messages set date = ? where id = ?').run(Date.parse('8496-06-13T03:38:25Z'), old.messageId);
    s.sqlite.prepare("update messages set labels = '[]' where id = ?").run(old.messageId);
    s.sqlite.prepare('delete from settings').run();

    await runRepairs(s, () => {});
    expect(row(fattura.conversationId).isNoise).toBe(false); // il filtro nuovo la tiene fuori dalle News
    expect(row(manual.conversationId).isNoise).toBe(true); // scelta manuale: non si tocca
    expect(s.db.select().from(messages).where(eq(messages.id, old.messageId!)).get()!.date).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(row(old.conversationId).lastMessageAt).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(row(old.conversationId).archivedAt).not.toBeNull();
    expect(row(fattura.conversationId).archivedAt).toBeNull();

    // Seconda volta: non fa nulla.
    s.sqlite.prepare('update conversations set is_noise = 1 where id = ?').run(fattura.conversationId);
    await runRepairs(s, () => {});
    expect(row(fattura.conversationId).isNoise).toBe(true);
  });
});

describe('regole per mittente (è / non è News, è / non è Spam)', () => {
  it('la regola sposta, propone le altre conversazioni dello stesso mittente e vale per la posta futura', async () => {
    const { saveRule, applyRule, previewRule, patternFor } = await import('../src/rules/sender-rules.ts');
    const from = (id: string, n: number, sender: string, subject = 'Novità') =>
      ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
        uid: n, mailbox: '[Gmail]/Tutti i messaggi', source: eml({ id: `<${id}@x>`, from: sender, subject, body: 'ciao' }),
        flags: [], labels: ['\\Inbox'], gmMsgid: `gm-${n}`, gmThreadId: `t-${n}`,
      });
    const a = await from('a', 800, 'postmaster@updates.shop.it');
    const b = await from('b', 801, 'info@shop.it');
    const c = await from('c', 802, 'altro@shop.it');
    const row = (id: string) => s.db.select().from(conversations).where(eq(conversations.id, id)).get()!;

    // "È una News" sul dominio: questa si sposta, le altre due vengono proposte.
    const pattern = patternFor('postmaster@updates.shop.it', 'domain');
    expect(pattern).toBe('@updates.shop.it');
    const domain = patternFor('info@shop.it', 'domain');
    saveRule(s.db, domain, 'news');
    applyRule(s.db, s.sqlite, b.conversationId, 'news');
    const preview = previewRule(s.sqlite, domain, 'news', b.conversationId);
    expect(preview.total).toBe(2); // anche il sottodominio updates.shop.it
    expect(preview.items.map((i) => i.conversationId).sort()).toEqual([a.conversationId, c.conversationId].sort());
    for (const i of preview.items) applyRule(s.db, s.sqlite, i.conversationId, 'news');
    expect([a, b, c].every((x) => row(x.conversationId).isNoise)).toBe(true);
    // Posta futura dello stesso dominio: nelle News da sola.
    const d = await from('d', 803, 'promo@mail.shop.it');
    expect(row(d.conversationId).isNoise).toBe(true);

    // "Non è una News" sull'indirizzo esatto vince sul dominio e sul filtro automatico.
    saveRule(s.db, 'newsletter@shop.it', 'not_news');
    const e = await from('e', 804, 'newsletter@shop.it');
    expect(row(e.conversationId).isNoise).toBe(false);

    // Spam: le future vanno nella vista Spam, non in Da smistare.
    saveRule(s.db, '@truffe.com', 'spam');
    const f = await from('f', 805, 'kk@truffe.com', 'Hai vinto');
    expect(row(f.conversationId).isSpam).toBe(true);
    expect(conv().list({ view: 'inbox' }).some((x) => x.id === f.conversationId)).toBe(false);
    expect(conv().list({ view: 'spam' }).map((x) => x.id)).toEqual([f.conversationId]);
    expect(conv().counts().spam).toBe(1);

    // Elenco ed eliminazione: eliminata, la regola non vale più per la posta futura.
    const { listRules, deleteRule } = await import('../src/rules/sender-rules.ts');
    expect(listRules(s.db).map((r) => [r.pattern, r.kind])).toEqual([['@truffe.com', 'spam'], ['newsletter@shop.it', 'not_news'], ['@shop.it', 'news']]);
    deleteRule(s.db, listRules(s.db).find((r) => r.pattern === '@truffe.com')!.id);
    const g = await from('g', 806, 'kk@truffe.com', 'Ancora');
    expect(row(g.conversationId).isSpam).toBe(false);
    expect(row(f.conversationId).isSpam).toBe(true); // quelle già spostate restano dove sono
  });
});

describe('posta importata da Gmail', () => {
  it('senza l\'etichetta Posta in arrivo la conversazione nasce archiviata; una risposta archiviata non la riporta in vista', async () => {
    const archived = await ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
      uid: 500, mailbox: '[Gmail]/Tutti i messaggi', source: eml({ id: '<old@x>', from: 'mario@x.it', subject: 'Vecchia', body: 'già letta' }),
      flags: ['\\Seen'], labels: [], gmMsgid: 'gm-500', gmThreadId: 'A',
    });
    const row = () => s.db.select().from(conversations).where(eq(conversations.id, archived.conversationId)).get()!;
    expect(row().archivedAt).not.toBeNull();
    const inbox = await incoming('<new@x>', 501, { gmThreadId: 'B' });
    expect(s.db.select().from(conversations).where(eq(conversations.id, inbox.conversationId)).get()!.archivedAt).toBeNull();
  });

  it('una data falsificata (anno 8496) viene sostituita da quella di arrivo', async () => {
    const r = await ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
      uid: 502, mailbox: '[Gmail]/Tutti i messaggi',
      source: Buffer.from('Message-ID: <spam@x>\r\nFrom: kk@hotmail.com\r\nTo: me@gmail.com\r\nSubject: Notifica\r\nDate: Sat, 13 Jun 8496 03:38:25 +0000\r\n\r\nciao'),
      flags: [], labels: ['\\Inbox'], gmMsgid: 'gm-502', gmThreadId: 'C', internalDate: new Date('2026-10-01T10:00:00Z'),
    });
    expect(s.db.select().from(messages).where(eq(messages.id, r.messageId!)).get()!.date).toBe(Date.parse('2026-10-01T10:00:00Z'));
  });
});

describe('staccare un messaggio (RF-C5)', () => {
  // Thread Gmail unico, catena di risposte con References completi e date crescenti.
  const reply = (n: number, refs: string[], subject = 'Riunione', thread = 'T') =>
    ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
      uid: 100 + n,
      mailbox: '[Gmail]/Tutti i messaggi',
      source: Buffer.from(
        [
          `Message-ID: <m${n}@x>`,
          'From: mario@x.it',
          'To: me@gmail.com',
          `Subject: ${subject}`,
          `Date: Wed, 07 Oct 2026 1${n}:00:00 +0200`,
          refs.length && `In-Reply-To: ${refs.at(-1)}`,
          refs.length && `References: ${refs.join(' ')}`,
          'Content-Type: text/plain; charset=utf-8',
        ]
          .filter(Boolean)
          .join('\r\n') + '\r\n\r\ntesto',
      ),
      flags: [],
      labels: ['\\Inbox'],
      gmMsgid: `gm-${100 + n}`,
      gmThreadId: thread,
    });
  const convOf = (rfc: string) => s.db.select().from(messages).where(eq(messages.rfcMessageId, rfc)).get()!.conversationId;

  it('stacca il ramo, le risposte successive vanno dove sta il genitore diretto, si può riunire', async () => {
    const a = await reply(1, []);
    await reply(2, ['<m1@x>']);
    // Qualcuno risponde alla vecchia conversazione per parlare d'altro.
    const c = await reply(3, ['<m1@x>', '<m2@x>'], 'Re: Riunione — preventivo');
    await reply(4, ['<m1@x>', '<m2@x>', '<m3@x>']);
    s.actions.move(a.conversationId, projectId);

    expect(() => s.actions.detach(a.messageId!)).toThrow(/primo messaggio/);
    const res = s.actions.detach(c.messageId!);
    expect(res).toMatchObject({ fromConversationId: a.conversationId, moved: 2 });
    expect(convOf('<m4@x>')).toBe(res.conversationId);
    expect(convOf('<m2@x>')).toBe(a.conversationId);
    const created = s.db.select().from(conversations).where(eq(conversations.id, res.conversationId)).get()!;
    expect(created).toMatchObject({ projectId, splitFromId: a.conversationId, subject: 'Riunione — preventivo' });

    // Risposta nel ramo staccato (References contiene tutta la catena, stesso thread Gmail): non riunisce.
    await reply(5, ['<m1@x>', '<m2@x>', '<m3@x>', '<m4@x>']);
    expect(convOf('<m5@x>')).toBe(res.conversationId);
    // Risposta nel ramo vecchio: resta nell'originale.
    await reply(6, ['<m1@x>', '<m2@x>']);
    expect(convOf('<m6@x>')).toBe(a.conversationId);
    // Solo thread Gmail, nessun riferimento: va nell'originale.
    await reply(7, []);
    expect(convOf('<m7@x>')).toBe(a.conversationId);

    // Annulla: tornano una conversazione sola.
    const back = s.actions.rejoin(res.conversationId);
    expect(back.conversationId).toBe(a.conversationId);
    expect(new Set(['<m1@x>', '<m3@x>', '<m5@x>'].map(convOf))).toEqual(new Set([a.conversationId]));
  });

  it('solo la mail (senza risposte); la staccata sta in cima finché non arriva altro', async () => {
    const a = await reply(1, []);
    await reply(2, ['<m1@x>']);
    const c = await reply(3, ['<m1@x>', '<m2@x>']);
    await reply(4, ['<m1@x>', '<m2@x>', '<m3@x>']);
    const other = await reply(9, [], 'Altro argomento', 'U'); // conversazione più recente
    s.actions.move(a.conversationId, projectId);
    s.actions.move(other.conversationId, projectId);
    const list = () => conv().list({ view: 'project', projectId });

    const res = s.actions.detach(c.messageId!, undefined, false);
    expect(res.moved).toBe(1);
    expect(convOf('<m4@x>')).toBe(a.conversationId);
    // In cima, anche se il suo messaggio è più vecchio di "Altro argomento".
    expect(list().map((x) => x.id)).toEqual([res.conversationId, other.conversationId, a.conversationId]);
    // Arriva un messaggio nuovo altrove: torna l'ordine per data.
    const z = await ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
      uid: 999, mailbox: '[Gmail]/Tutti i messaggi', flags: [], labels: ['\\Inbox'], gmMsgid: 'gm-999', gmThreadId: 'Z',
      source: Buffer.from(`Message-ID: <z@x>\r\nFrom: anna@x.it\r\nTo: me@gmail.com\r\nSubject: Nuova\r\nDate: ${new Date(Date.now() + 60_000).toUTCString()}\r\n\r\nciao`),
    });
    s.actions.move(z.conversationId, projectId);
    expect(list()[0]!.subject).toBe('Nuova');
  });

  it('stacca e sposta in Da smistare: la nuova conversazione si riclassifica', async () => {
    await reply(1, []);
    const b = await reply(2, ['<m1@x>']);
    const res = s.actions.detach(b.messageId!, null);
    expect(s.db.select().from(conversations).where(eq(conversations.id, res.conversationId)).get()!.projectId).toBeNull();
  });
});
