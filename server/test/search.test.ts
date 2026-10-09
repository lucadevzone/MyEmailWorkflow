import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage } from '../src/ingest/ingest.ts';
import { embedMessage } from '../src/ai/embed.ts';
import { ProjectService } from '../src/projects/service.ts';
import type { Embedder } from '../src/ai/embed.ts';

/** Vettore "a sacco di parole": testi con parole in comune sono vicini. Sinonimi forzati per provare il significato. */
const SYN: Record<string, string> = { fattura: 'pagamento', bonifico: 'pagamento', saldo: 'pagamento' };
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Array(1024).fill(0);
    for (const w of t.toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
      const k = SYN[w] ?? w;
      let h = 0;
      for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) % 1024;
      v[h] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

let s: ReturnType<typeof buildServices>;
let accountId: string;
let projectId: string;

async function mail(id: string, uid: number, subject: string, body: string, from = 'mario@x.it') {
  const source = Buffer.from(
    [`Message-ID: ${id}`, `From: Mario Rossi <${from}>`, 'To: me@gmail.com', `Subject: ${subject}`, 'Date: Wed, 07 Oct 2026 10:00:00 +0200', 'Content-Type: text/plain; charset=utf-8'].join('\r\n') +
      `\r\n\r\n${body}`,
  );
  const r = await ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
    uid, mailbox: '[Gmail]/Tutti i messaggi', source, flags: ['\\Seen'], labels: ['\\Inbox'], gmMsgid: `gm-${uid}`, gmThreadId: `t-${uid}`,
  });
  await embedMessage(s.db, s.sqlite, r.messageId!, fakeEmbedder);
  return r;
}

beforeEach(() => {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), { embedder: fakeEmbedder });
  accountId = s.accounts.create({ name: 'Prova', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;
  projectId = new ProjectService(db).create({ name: 'PNRR', outgoingAccountId: accountId }).id;
});

describe('ricerca unica', () => {
  it('trova per parola (anche con prefisso) e per significato', async () => {
    const a = await mail('<a@x>', 1, 'Riunione di progetto', 'Ci vediamo giovedì per la riunione di avanzamento.');
    const b = await mail('<b@x>', 2, 'Fattura marzo', 'In allegato la fattura del mese di marzo.');
    const r1 = await s.search.search('riun');
    expect(r1.conversations.map((c) => c.conversationId)).toEqual([a.conversationId]);
    expect(r1.conversations[0]!.snippet).toMatch(/riunione/i);
    expect(r1.conversations[0]!.participants[0]).toMatchObject({ email: 'mario@x.it' });
    // "bonifico" non compare in nessun testo: lo trova il significato (sinonimo di fattura nel finto embedder).
    const r2 = await s.search.search('bonifico');
    expect(r2.semantic).toBe(true);
    expect(r2.conversations[0]?.conversationId).toBe(b.conversationId);
  });

  it('ambito: solo il progetto, oppure Da smistare', async () => {
    const a = await mail('<c@x>', 3, 'Relazione finale', 'La relazione finale è pronta.');
    const b = await mail('<d@x>', 4, 'Relazione intermedia', 'Ecco la relazione intermedia.');
    s.actions.move(a.conversationId!, projectId);
    expect((await s.search.search('relazione', `project:${projectId}`)).conversations.map((c) => c.conversationId)).toEqual([a.conversationId]);
    expect((await s.search.search('relazione', 'inbox')).conversations.map((c) => c.conversationId)).toEqual([b.conversationId]);
    expect((await s.search.search('relazione')).conversations).toHaveLength(2);
  });

  it('risorse, task e note', async () => {
    const a = await mail('<e@x>', 5, 'Budget', 'Il budget va rivisto.');
    s.actions.move(a.conversationId!, projectId);
    s.notes.addFile({ conversationId: a.conversationId! }, 'budget-2026.xlsx', Buffer.from('x'), null);
    s.tasks.create({ projectId, conversationId: a.conversationId!, title: 'Rivedere il budget' });
    s.notes.createNote({ conversationId: a.conversationId!, body: 'Chiedere a Mario il budget aggiornato' });
    const r = await s.search.search('budget');
    expect(r.files.map((f) => [f.kind, f.title])).toEqual([['resource', 'budget-2026.xlsx']]);
    expect(r.items.map((i) => i.kind).sort()).toEqual(['note', 'task']);
    expect(r.items.every((i) => i.projectId === projectId)).toBe(true);
  });

  it('senza Ollama resta la ricerca per parole', async () => {
    const off = buildServices(s.db, s.sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
      embedder: async () => {
        throw new Error('offline');
      },
    });
    await mail('<f@x>', 6, 'Convegno', 'Il convegno si terrà a Roma.');
    const r = await off.search.search('convegno');
    expect(r.semantic).toBe(false);
    expect(r.conversations).toHaveLength(1);
  });

  it('richiesta vuota o solo punteggiatura: nessun risultato', async () => {
    expect((await s.search.search('  ?! ')).conversations).toEqual([]);
  });
});

describe('fonte di note e task', () => {
  it('la nota ricorda il messaggio da cui è nata', async () => {
    const a = await mail('<g@x>', 7, 'Verbale', 'Il verbale della riunione è in allegato.');
    const n = s.notes.createNote({ conversationId: a.conversationId!, messageId: a.messageId!, body: '> verbale\n\nda rileggere' });
    expect(n.messageId).toBe(a.messageId);
    const d = new (await import('../src/conversations/service.ts')).ConversationService(s.db).get(a.conversationId!)!;
    expect(d.notes[0]!.messageId).toBe(a.messageId);
  });
});
