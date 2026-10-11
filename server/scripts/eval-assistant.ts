// Banco di prova dell'assistente: domande con risposta attesa sulla posta di prova.
//
//   pnpm eval:assistant                      modello delle impostazioni
//   pnpm eval:assistant --model mistral-nemo confronta un altro modello (stesso contesto)
//   pnpm eval:assistant --case palestra      solo i casi il cui id contiene "palestra"
//
// Legge il database vero senza scriverci (la chat non viene salvata). Stampa esito e tempi per caso
// e salva i risultati in eval/results/ per confrontare le prove nel tempo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull, like } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { openDb } from '../src/db/client.ts';
import { conversations, messages } from '../src/db/schema.ts';
import { buildServices } from '../src/services.ts';
import { findAskSources } from '../src/ai/ask-sources.ts';
import type { AssistantAction } from '../src/ai/assistant.ts';

interface Case {
  id: string;
  kind: 'ask' | 'read' | 'compose';
  question?: string;
  action?: AssistantAction;
  draftBody?: string;
  conversation?: { subject: string; contains?: string };
  expect: string[][];
  forbid?: string[];
}

interface Result {
  id: string;
  kind: Case['kind'];
  pass: boolean;
  missing: string[];
  forbidden: string[];
  badCitations: number[];
  firstTokenMs: number;
  totalMs: number;
  answer: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const { db, sqlite } = openDb();
const s = buildServices(db, sqlite, config.blobDir);
if (arg('model')) config.ollama.llmModel = arg('model')!;
const filter = arg('case');
const cases = (JSON.parse(fs.readFileSync(path.join(here, '../eval/assistant-cases.json'), 'utf8')) as { cases: Case[] }).cases.filter(
  (c) => !filter || c.id.includes(filter),
);

/** La conversazione del caso: per oggetto e, se serve, per un testo contenuto nei messaggi o negli allegati. */
function findConversation(q: NonNullable<Case['conversation']>): string {
  const rows = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.subject, q.subject), isNull(conversations.deletedAt)))
    .all();
  const match = rows.find((r) => {
    if (!q.contains) return true;
    const inBody = db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, r.id), like(messages.bodyText, `%${q.contains}%`)))
      .get();
    const inFiles = sqlite
      .prepare('select 1 from attachments a join messages m on m.id = a.message_id where m.conversation_id = ? and a.filename like ?')
      .get(r.id, `%${q.contains}%`);
    return !!inBody || !!inFiles;
  });
  if (!match) throw new Error(`Conversazione non trovata: ${q.subject}${q.contains ? ` (${q.contains})` : ''}`);
  return match.id;
}

async function run(c: Case): Promise<Result> {
  let sourcesCount = 0;
  let gen: AsyncIterable<string>;
  if (c.kind === 'ask') {
    const sources = await findAskSources(s.search, c.question!);
    sourcesCount = sources.length;
    gen = s.assistant.ask(c.question!, sources.map(({ conversationId, messageId }) => ({ conversationId, messageId })));
  } else {
    const conversationId = c.conversation ? findConversation(c.conversation) : null;
    gen = s.assistant.chat(
      {
        mode: c.kind === 'read' ? 'read' : 'compose',
        conversationId,
        draftId: conversationId ? null : 'new',
        action: c.action,
        draftBody: c.draftBody,
        text: c.question ?? c.action ?? 'Rispondi',
      },
      undefined,
      { persist: false },
    );
  }

  const start = performance.now();
  let first = 0;
  let answer = '';
  for await (const piece of gen) {
    if (!first) first = performance.now();
    answer += piece;
  }
  const end = performance.now();
  answer = answer.trim();

  const missing = c.expect.filter((group) => !group.some((re) => new RegExp(re, 'i').test(answer))).map((g) => g.join(' | '));
  const forbidden = (c.forbid ?? []).filter((re) => new RegExp(re, 'im').test(answer));
  // Citazioni [n] che non corrispondono a nessuna fonte.
  const badCitations = c.kind === 'ask' ? [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => n < 1 || n > sourcesCount) : [];
  return {
    id: c.id,
    kind: c.kind,
    pass: !missing.length && !forbidden.length && !badCitations.length,
    missing,
    forbidden,
    badCitations: [...new Set(badCitations)],
    firstTokenMs: Math.round((first || end) - start),
    totalMs: Math.round(end - start),
    answer,
  };
}

console.log(`Modello: ${config.ollama.llmModel} · contesto ${config.ollama.numCtx} token · ${cases.length} casi\n`);

// Il primo giro carica il modello: lo si misura a parte, così i tempi dei casi sono "a modello caldo".
const warm = performance.now();
for await (const _ of s.assistant.chat({ mode: 'compose', draftId: 'new', text: 'Scrivi solo: ok' }, undefined, { persist: false })) void _;
const loadMs = Math.round(performance.now() - warm);
console.log(`Caricamento / primo giro: ${(loadMs / 1000).toFixed(1)} s\n`);

const results: Result[] = [];
for (const c of cases) {
  let r: Result;
  try {
    r = await run(c);
  } catch (err) {
    r = { id: c.id, kind: c.kind, pass: false, missing: [`errore: ${(err as Error).message}`], forbidden: [], badCitations: [], firstTokenMs: 0, totalMs: 0, answer: '' };
  }
  results.push(r);
  const why = [
    ...r.missing.map((m) => `manca «${m}»`),
    ...r.forbidden.map((f) => `contiene «${f}»`),
    ...(r.badCitations.length ? [`citazioni inesistenti ${r.badCitations.map((n) => `[${n}]`).join(' ')}`] : []),
  ];
  console.log(`${r.pass ? '✓' : '✗'} ${r.id.padEnd(26)} ${(r.totalMs / 1000).toFixed(1).padStart(5)} s  ${why.join('; ')}`);
  if (!r.pass || process.argv.includes('--verbose')) console.log(`    ${r.answer.replace(/\s+/g, ' ').slice(0, 300)}\n`);
}

const passed = results.filter((r) => r.pass).length;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(
  `\nSuperati ${passed}/${results.length} · tempo medio ${(avg(results.map((r) => r.totalMs)) / 1000).toFixed(1)} s` +
    ` · primo token in media ${(avg(results.map((r) => r.firstTokenMs)) / 1000).toFixed(1)} s`,
);

const outDir = path.join(here, '../eval/results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const file = path.join(outDir, `${stamp}-${config.ollama.llmModel.replace(/[^a-z0-9.-]+/gi, '_')}.json`);
fs.writeFileSync(file, JSON.stringify({ model: config.ollama.llmModel, numCtx: config.ollama.numCtx, loadMs, passed, total: results.length, results }, null, 2));
console.log(`Risultati: ${path.relative(process.cwd(), file)}`);
sqlite.close();
