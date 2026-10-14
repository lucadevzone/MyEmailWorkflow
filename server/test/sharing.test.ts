import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage } from '../src/ingest/ingest.ts';
import { ConversationService } from '../src/conversations/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { exportPersonal, gunzipFile, gzipFile, importPersonal } from '../src/sharing/exchange.ts';
import { accounts } from '../src/db/schema.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-share-'));

/** Un "PC": database proprio, servizi propri. */
function pc() {
  const dir = tmp();
  const { db, sqlite } = openDb(path.join(dir, 'mmw.sqlite'));
  runMigrations(db);
  const s = buildServices(db, sqlite, path.join(dir, 'blobs'), {
    createProvider: () => {
      throw new Error('niente IMAP nei test');
    },
  });
  return { s, dir, conv: new ConversationService(db), projects: new ProjectService(db) };
}

const eml = (o: { id: string; subject: string; inReplyTo?: string; from?: string }) =>
  Buffer.from(
    [
      `Message-ID: ${o.id}`,
      `From: ${o.from ?? 'Mario Rossi <mario@x.it>'}`,
      'To: me@gmail.com',
      `Subject: ${o.subject}`,
      'Date: Wed, 07 Oct 2026 10:00:00 +0200',
      o.inReplyTo && `In-Reply-To: ${o.inReplyTo}`,
      'Content-Type: text/plain; charset=utf-8',
    ]
      .filter(Boolean)
      .join('\r\n') + '\r\n\r\nTesto',
  );

/** La stessa posta, importata da Gmail su un PC (i codici locali cambiano da PC a PC). */
async function importMail(p: ReturnType<typeof pc>, accountId: string) {
  const mails = [
    { id: '<a1@x>', subject: 'Preventivo', thread: 'T1' },
    { id: '<a2@x>', subject: 'Re: Preventivo', thread: 'T1', inReplyTo: '<a1@x>' },
    { id: '<b1@x>', subject: 'Fattura', thread: 'T2' },
    { id: '<c1@x>', subject: 'Riunione', thread: 'T3' },
    { id: '<d1@x>', subject: 'Agenda riunione', thread: 'T4' },
  ];
  let uid = 1;
  for (const m of mails) {
    await ingestMessage(p.s, { id: accountId, email: 'me@gmail.com' }, {
      uid: uid++,
      mailbox: 'All',
      source: eml(m),
      flags: [],
      labels: ['\\Inbox'],
      gmMsgid: `gm-${m.id}`,
      gmThreadId: m.thread,
    });
  }
}

const convOf = (p: ReturnType<typeof pc>, rfc: string) =>
  p.s.sqlite.prepare('select conversation_id as c from messages where rfc_message_id = ? and deleted_at is null').get(rfc) as { c: string };
const msgOf = (p: ReturnType<typeof pc>, rfc: string) => (p.s.sqlite.prepare('select id from messages where rfc_message_id = ?').get(rfc) as { id: string }).id;

describe('scambio dei dati personali tra PC', () => {
  it('andata e ritorno: progetti, conversazioni (anche unite), task sui messaggi, regole, contatti; la posta non viaggia', async () => {
    // ── PC A: l'app usata finora.
    const A = pc();
    const accountId = A.s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'keychain:x' }).id;
    await importMail(A, accountId);
    const cat = A.projects.createCategory({ name: 'Lavoro' });
    const project = A.projects.create({ name: 'Gare', outgoingAccountId: accountId, categoryId: cat.id });
    A.s.actions.move(convOf(A, '<a1@x>').c, project.id);
    A.s.actions.archive(convOf(A, '<b1@x>').c);
    const merged = A.s.actions.merge([convOf(A, '<c1@x>').c, convOf(A, '<d1@x>').c]).conversationId;
    const task = A.s.tasks.create({ projectId: project.id, title: 'Rispondere sul preventivo', conversationId: convOf(A, '<a1@x>').c, messageId: msgOf(A, '<a2@x>') });
    A.s.sqlite.prepare("insert into sender_rules (id, pattern, kind, created_at) values ('r1', '@shop.it', 'news', 1)").run();
    A.s.people.createContact({ name: 'Mario Rossi', emails: ['mario@x.it'] });
    A.s.settings.update({ aiWindowDays: 365, aiPaused: true });

    const dir = tmp();
    const file = path.join(dir, 'personale-1.sqlite');
    exportPersonal(A.s.sqlite, file, { version: 1, machine: 'A', exportedAt: Date.now() });
    // Viaggia compresso: pochi KB, senza il testo delle mail.
    gzipFile(file, `${file}.gz`);
    expect(fs.statSync(`${file}.gz`).size).toBeLessThan(40_000);

    // ── PC B, la prima volta: arrivano i dati personali, la posta ancora no.
    const B = pc();
    const raw = path.join(dir, 'arrivato.sqlite');
    gunzipFile(`${file}.gz`, raw);
    const first = importPersonal(B.s.sqlite, raw);
    expect(first).toMatchObject({ version: 1, machine: 'A', movedMessages: 0 });
    expect(first.pendingConversations).toBeGreaterThan(0);
    expect(first.pendingRefs).toBeGreaterThan(0); // il task punta a un messaggio non ancora arrivato
    expect(B.projects.list().map((p) => p.name)).toEqual(['Gare']);
    expect(B.projects.categories().map((c) => c.name)).toEqual(['Lavoro']);
    expect(B.s.tasks.forProject(project.id).map((t) => t.title)).toEqual(['Rispondere sul preventivo']);
    expect(B.s.db.select().from(accounts).all().map((a) => a.id)).toEqual([accountId]);
    // Impostazioni: le comuni sì, quelle di questo PC no.
    expect(B.s.settings.get()).toMatchObject({ aiWindowDays: 365, aiPaused: false });

    // ── B importa la posta da Gmail (codici locali diversi) e riprende i dati personali.
    await importMail(B, accountId);
    expect(msgOf(B, '<a2@x>')).not.toBe(msgOf(A, '<a2@x>'));
    const second = importPersonal(B.s.sqlite, raw);
    expect(second.pendingConversations).toBe(0);
    expect(second.pendingRefs).toBe(0);
    expect(convOf(B, '<a1@x>').c).toBe(convOf(A, '<a1@x>').c); // codici delle conversazioni comuni
    expect(B.conv.list({ view: 'project', projectId: project.id }).map((c) => c.id)).toEqual([convOf(A, '<a1@x>').c]);
    expect(B.conv.list({ view: 'inbox', archived: true }).map((c) => c.id)).toEqual([convOf(A, '<b1@x>').c]);
    // L'unione fatta su A vale anche su B.
    expect(convOf(B, '<c1@x>').c).toBe(merged);
    expect(convOf(B, '<d1@x>').c).toBe(merged);
    expect(B.conv.get(merged)!.messages).toHaveLength(2);
    // Il task ritrova il messaggio con il codice locale di B.
    expect(B.s.tasks.get(task.id)).toMatchObject({ messageId: msgOf(B, '<a2@x>'), conversationId: convOf(A, '<a1@x>').c });
    expect(B.s.sqlite.prepare("select pattern from sender_rules").all()).toEqual([{ pattern: '@shop.it' }]);
    expect(B.s.people.directory().contacts.map((c) => c.name)).toEqual(['Mario Rossi']);
    // Nessuna conversazione doppia: quelle create da B con l'importazione sono state assorbite.
    expect(B.conv.list({ view: 'inbox' }).length + B.conv.list({ view: 'inbox', archived: true }).length).toBe(2);

    // ── Ritorno: B lavora, consegna; A riprende.
    B.s.actions.move(convOf(B, '<b1@x>').c, project.id);
    B.s.tasks.create({ projectId: project.id, title: 'Pagare la fattura', conversationId: convOf(B, '<b1@x>').c, messageId: msgOf(B, '<b1@x>') });
    const back = path.join(dir, 'personale-2.sqlite');
    exportPersonal(B.s.sqlite, back, { version: 2, machine: 'B', exportedAt: Date.now() });
    const r = importPersonal(A.s.sqlite, back);
    expect(r).toMatchObject({ version: 2, machine: 'B', pendingRefs: 0, pendingConversations: 0 });
    expect(A.conv.list({ view: 'project', projectId: project.id }).map((c) => c.id)).toEqual([convOf(A, '<a1@x>').c]);
    expect(A.conv.list({ view: 'project', projectId: project.id, archived: true }).map((c) => c.id)).toEqual([convOf(A, '<b1@x>').c]); // spostata da B, resta archiviata
    expect(A.s.tasks.forProject(project.id).map((t) => t.title)).toEqual(['Rispondere sul preventivo', 'Pagare la fattura']);
    expect(A.s.tasks.forProject(project.id).find((t) => t.title === 'Pagare la fattura')!.messageId).toBe(msgOf(A, '<b1@x>'));
    expect(A.s.settings.get().aiPaused).toBe(true); // impostazione di A, non toccata
  });

  it("un invio ancora in coda viaggia con il suo messaggio e parte dall'altro PC", async () => {
    const A = pc();
    const accountId = A.s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'keychain:x' }).id;
    await importMail(A, accountId);
    const project = A.projects.create({ name: 'Gare', outgoingAccountId: accountId });
    A.s.actions.move(convOf(A, '<a1@x>').c, project.id);
    const sent = A.s.actions.compose({ projectId: project.id, replyToMessageId: msgOf(A, '<a2@x>'), to: ['mario@x.it'], cc: [], bcc: [], subject: '', body: 'Ecco il preventivo', urgent: false });
    const file = path.join(tmp(), 'p.sqlite');
    exportPersonal(A.s.sqlite, file, { version: 1, machine: 'A', exportedAt: Date.now() });

    const B = pc();
    importPersonal(B.s.sqlite, file);
    await importMail(B, accountId);
    importPersonal(B.s.sqlite, file);
    const act = B.s.activities.list().find((a) => a.kind === 'send')!;
    expect(act.status).toBe('pending');
    const p = B.s.sqlite.prepare('select payload from activities where id = ?').get(act.id) as { payload: string };
    const local = JSON.parse(p.payload).messageId as string;
    const m = B.s.sqlite.prepare('select conversation_id as c, outgoing_status as st, body_text as body from messages where id = ?').get(local) as { c: string; st: string; body: string };
    expect(m).toMatchObject({ c: sent.conversationId, st: 'queued' });
    expect(m.body).toContain('Ecco il preventivo');
  });
});
