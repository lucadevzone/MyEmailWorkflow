import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage } from '../src/ingest/ingest.ts';
import { ProjectService } from '../src/projects/service.ts';
import type { ChatTurn } from '../src/ai/assistant.ts';

let s: ReturnType<typeof buildServices>;
let projectId: string;
let accountId: string;
let lastTurns: ChatTurn[];
let reply: string[];
let llmCalls: number;

async function incoming(id: string, uid: number, body: string) {
  const source = Buffer.from(
    [`Message-ID: ${id}`, 'From: Mario <mario@x.it>', 'To: me@gmail.com', 'Subject: Riunione', 'Date: Wed, 07 Oct 2026 10:00:00 +0200', 'Content-Type: text/plain; charset=utf-8'].join('\r\n') +
      `\r\n\r\n${body}`,
  );
  return ingestMessage(s, { id: accountId, email: 'me@gmail.com' }, {
    uid, mailbox: '[Gmail]/Tutti i messaggi', source, flags: [], labels: ['\\Inbox'], gmMsgid: `gm-${uid}`, gmThreadId: 'T',
  });
}

async function collect(gen: AsyncIterable<string>) {
  let out = '';
  for await (const p of gen) out += p;
  return out;
}

beforeEach(() => {
  const { db, sqlite } = openDb(':memory:');
  runMigrations(db);
  reply = ['Ciao ', 'Mario', '.'];
  llmCalls = 0;
  s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
    chatStream: async function* (turns) {
      lastTurns = turns;
      for (const p of reply) yield p;
    },
    llm: (async () => {
      llmCalls++;
      return { idee: [{ titolo: 'Conferma la data', descrizione: 'Dì che giovedì va bene.' }, { titolo: '', descrizione: 'scartata' }] };
    }) as never,
  });
  accountId = s.accounts.create({ name: 'Prova', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;
  projectId = new ProjectService(db).create({ name: 'PNRR', outgoingAccountId: accountId }).id;
});

describe('assistente', () => {
  it('lettura: streaming, contesto con la conversazione e chat salvata', async () => {
    const { conversationId, messageId } = await incoming('<1@x>', 1, 'Ci vediamo giovedì alle 10?');
    const out = await collect(s.assistant.chat({ conversationId, mode: 'read', messageId, text: 'Riassumi la conversazione', action: 'summarize' }));
    expect(out).toBe('Ciao Mario.');
    expect(lastTurns[0]!.content).toContain('Ci vediamo giovedì alle 10?');
    expect(lastTurns[0]!.content).toContain('(APERTO)');
    expect(lastTurns.at(-1)!.content).toMatch(/Riassumi la conversazione in poche frasi/);
    const thread = s.assistant.thread(conversationId);
    expect(thread.map((m) => [m.role, m.mode, m.content])).toEqual([
      ['user', 'read', 'Riassumi la conversazione'],
      ['assistant', 'read', 'Ciao Mario.'],
    ]);
    // La domanda successiva porta con sé la storia.
    await collect(s.assistant.chat({ conversationId, mode: 'read', text: 'E poi?' }));
    expect(lastTurns.map((t) => t.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('composizione: la bozza entra nel contesto; i ritocchi agiscono sull\'ultima proposta', async () => {
    const { conversationId } = await incoming('<2@x>', 2, 'Mi mandi il report?');
    await collect(s.assistant.chat({ conversationId, mode: 'compose', draftBody: 'Certo, te lo mando', text: 'Proponi una risposta' }));
    expect(lastTurns[0]!.content).toContain('BOZZA ATTUALE');
    expect(lastTurns[0]!.content).toContain('Certo, te lo mando');
    await collect(s.assistant.chat({ conversationId, mode: 'compose', action: 'formal', text: 'Più formale' }));
    expect(lastTurns.at(-1)!.content).toContain('Ciao Mario.');
    expect(lastTurns.at(-1)!.content).toMatch(/formale/);
  });

  it('ritocco senza testo: errore chiaro', async () => {
    const { conversationId } = await incoming('<3@x>', 3, 'Ciao');
    await expect(collect(s.assistant.chat({ conversationId, mode: 'compose', action: 'fix', text: 'Correggi', draftBody: '' }))).rejects.toThrow(/ritoccare/);
  });

  it('idee di risposta: filtrate e ricalcolate solo con un messaggio nuovo', async () => {
    const { conversationId } = await incoming('<4@x>', 4, 'Va bene giovedì?');
    expect(await s.assistant.replyIdeas(conversationId)).toEqual([{ title: 'Conferma la data', description: 'Dì che giovedì va bene.' }]);
    await s.assistant.replyIdeas(conversationId);
    expect(llmCalls).toBe(1);
    await incoming('<5@x>', 5, 'Oppure venerdì?');
    await s.assistant.replyIdeas(conversationId);
    expect(llmCalls).toBe(2);
  });

  it('nuova mail: la chat della bozza passa alla conversazione nata dall\'invio', async () => {
    const d = s.drafts.create({ projectId, to: ['anna@y.it'], subject: 'Ciao' });
    await collect(s.assistant.chat({ draftId: d.id, mode: 'compose', text: 'Scrivi un saluto' }));
    expect(s.assistant.thread(`draft:${d.id}`)).toHaveLength(2);
    const r = s.drafts.send(d.id, false);
    expect(s.assistant.thread(`draft:${d.id}`)).toHaveLength(0);
    expect(s.assistant.thread(r.conversationId)).toHaveLength(2);
  });
});
