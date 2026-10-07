import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { BlobStore } from '../src/store/blobs.ts';
import { ingestMessage, type IngestContext, type RawFetched } from '../src/ingest/ingest.ts';
import { ConversationService } from '../src/conversations/service.ts';
import { accounts, conversations, messages } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';

const ACCOUNT = { id: 'acc1', email: 'me@gmail.com' };
let ctx: IngestContext;

beforeEach(() => {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  const t = Date.now();
  db.insert(accounts)
    .values({
      id: ACCOUNT.id, name: 'Prova', email: ACCOUNT.email, provider: 'gmail',
      imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
      smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
      username: ACCOUNT.email, authType: 'password', credentialRef: 'env:X', createdAt: t, updatedAt: t,
    })
    .run();
  ctx = { db, sqlite, blobs: new BlobStore(db, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-'))) };
});

function eml(o: { id: string; from: string; to?: string; subject: string; body: string; inReplyTo?: string; refs?: string[]; date?: string; extra?: string }) {
  const headers = [
    `Message-ID: ${o.id}`,
    `From: ${o.from}`,
    `To: ${o.to ?? 'Me <me@gmail.com>'}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? 'Wed, 07 Oct 2026 10:00:00 +0200'}`,
    o.inReplyTo && `In-Reply-To: ${o.inReplyTo}`,
    o.refs && `References: ${o.refs.join(' ')}`,
    o.extra,
    'Content-Type: text/plain; charset=utf-8',
  ].filter(Boolean);
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${o.body}`);
}

const raw = (source: Buffer, extra: Partial<RawFetched> = {}): RawFetched => ({
  uid: null, mailbox: 'All', source, flags: [], labels: [], ...extra,
});

describe('ingest', () => {
  it('salva il messaggio, pulisce il testo e crea una conversazione da smistare', async () => {
    const r = await ingestMessage(ctx, ACCOUNT, raw(eml({
      id: '<a@x>', from: 'Mario Rossi <Mario@X.it>', subject: 'Riunione',
      body: 'Ci vediamo giovedì?\r\n\r\nIl giorno mar 6 ott 2026 Luca ha scritto:\r\n> vecchio',
    }), { uid: 10, flags: ['\\Seen'] }));
    expect(r.created).toBe(true);
    const msg = ctx.db.select().from(messages).where(eq(messages.id, r.messageId)).get()!;
    expect(msg.bodyTextClean).toBe('Ci vediamo giovedì?');
    expect(msg.fromAddress).toBe('mario@x.it');
    expect(msg.seen).toBe(true);
    expect(msg.direction).toBe('in');
    const conv = ctx.db.select().from(conversations).where(eq(conversations.id, r.conversationId)).get()!;
    expect(conv.projectId).toBeNull();
    expect(conv.isNoise).toBe(false);
  });

  it('non duplica lo stesso messaggio (X-GM-MSGID) e aggiorna i flag', async () => {
    const src = eml({ id: '<a@x>', from: 'a@x.it', subject: 'S', body: 'b' });
    const r1 = await ingestMessage(ctx, ACCOUNT, raw(src, { gmMsgid: '111' }));
    const r2 = await ingestMessage(ctx, ACCOUNT, raw(src, { gmMsgid: '111', flags: ['\\Seen'] }));
    expect(r2).toMatchObject({ messageId: r1.messageId, created: false });
    expect(ctx.db.select().from(messages).all()).toHaveLength(1);
    expect(ctx.db.select().from(messages).get()!.seen).toBe(true);
  });

  it('raggruppa per thread Gmail', async () => {
    const r1 = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<1@x>', from: 'a@x.it', subject: 'S', body: '1' }), { gmThreadId: 'T1', gmMsgid: '1' }));
    const r2 = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<2@x>', from: 'b@x.it', subject: 'Altro', body: '2' }), { gmThreadId: 'T1', gmMsgid: '2' }));
    expect(r2.conversationId).toBe(r1.conversationId);
  });

  it('raggruppa per In-Reply-To/References (IMAP generico)', async () => {
    const r1 = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<1@x>', from: 'a@x.it', subject: 'S', body: '1' })));
    const r2 = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<2@x>', from: 'me@gmail.com', to: 'a@x.it', subject: 'Re: S', body: '2', inReplyTo: '<1@x>', refs: ['<1@x>'] })));
    expect(r2.conversationId).toBe(r1.conversationId);
    expect(ctx.db.select().from(messages).where(eq(messages.id, r2.messageId)).get()!.direction).toBe('out');
  });

  it('unisce le conversazioni quando arriva il genitore dopo i figli (backfill)', async () => {
    const child1 = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<2@x>', from: 'b@x.it', subject: 'Re: S', body: '2', inReplyTo: '<1@x>', refs: ['<1@x>'] })));
    const child2 = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<3@x>', from: 'c@x.it', subject: 'Re: S', body: '3', inReplyTo: '<1@x>', refs: ['<1@x>'] })));
    expect(child2.conversationId).not.toBe(child1.conversationId);
    const parent = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<1@x>', from: 'a@x.it', subject: 'S', body: '1' })));
    const convIds = new Set(ctx.db.select({ c: messages.conversationId }).from(messages).all().map((m) => m.c));
    expect(convIds.size).toBe(1);
    expect(convIds.has(parent.conversationId)).toBe(true);
    const live = new ConversationService(ctx.db).list({ view: 'inbox' });
    expect(live).toHaveLength(1);
    expect(live[0]!.messageCount).toBe(3);
  });

  it('manda le newsletter nel rumore e le elenca separatamente', async () => {
    await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<n@x>', from: 'news@shop.it', subject: 'Offerte', body: 'saldi', extra: 'List-Unsubscribe: <mailto:u@shop.it>' })));
    await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<p@x>', from: 'mario@x.it', subject: 'Ciao', body: 'ciao' })));
    const svc = new ConversationService(ctx.db);
    expect(svc.list({ view: 'inbox' }).map((c) => c.subject)).toEqual(['Ciao']);
    expect(svc.list({ view: 'noise' }).map((c) => c.subject)).toEqual(['Offerte']);
    expect(svc.list({ view: 'inbox' })[0]!.participants).toEqual([{ name: null, email: 'mario@x.it' }]);
  });

  it('indicizza il testo per la ricerca full-text', async () => {
    const r = await ingestMessage(ctx, ACCOUNT, raw(eml({ id: '<f@x>', from: 'a@x.it', subject: 'Preventivo', body: 'Allego il preventivo per la manutenzione' })));
    const hit = ctx.sqlite.prepare("select message_id from message_fts where message_fts match 'manutenzione'").get() as { message_id: string };
    expect(hit.message_id).toBe(r.messageId);
  });
});
