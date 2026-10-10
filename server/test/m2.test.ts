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

  it('bozza senza progetto non si invia', () => {
    const d = s.drafts.create({ to: ['a@b.it'] });
    expect(() => s.drafts.send(d.id, false)).toThrow(/progetto/);
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
