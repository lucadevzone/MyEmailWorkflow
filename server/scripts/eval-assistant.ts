// Banco di prova dell'assistente: domande con risposta attesa sulla posta di prova.
//
//   pnpm eval:assistant                      modello delle impostazioni
//   pnpm eval:assistant --model mistral-nemo confronta un altro modello (stesso contesto)
//   pnpm eval:assistant --case palestra      solo i casi il cui id contiene "palestra"
//   pnpm eval:assistant --runs 3             ripete tutto 3 volte: i modelli piccoli non rispondono sempre uguale
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
import type { AssistantAction } from '../src/ai/assistant.ts';

interface Case {
  id: string;
  kind: 'ask' | 'read' | 'compose';
  question?: string;
  action?: AssistantAction;
  draftBody?: string;
  selection?: string;
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
  /** Risposta su tutta la posta che cita almeno un messaggio (non serve se dice di non aver trovato). */
  cites: boolean | null;
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
    const { sources, turns } = await s.assistant.prepareAsk(c.question!);
    sourcesCount = sources.length;
    gen = s.assistant.ask(turns);
  } else {
    const conversationId = c.conversation ? findConversation(c.conversation) : null;
    gen = s.assistant.chat(
      {
        mode: c.kind === 'read' ? 'read' : 'compose',
        conversationId,
        draftId: conversationId ? null : 'new',
        action: c.action,
        draftBody: c.draftBody,
        selection: c.selection,
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
    cites: c.kind === 'ask' && !/non ho trovato/i.test(answer) ? /\[\d+\]/.test(answer) : null,
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

const runs = Math.max(1, Number(arg('runs') ?? 1));
const results: Result[] = [];
for (let round = 1; round <= runs; round++) {
  if (runs > 1) console.log(`— Giro ${round} di ${runs}`);
  for (const c of cases) {
    let r: Result;
    try {
      r = await run(c);
    } catch (err) {
      r = { id: c.id, kind: c.kind, pass: false, missing: [`errore: ${(err as Error).message}`], forbidden: [], badCitations: [], cites: null, firstTokenMs: 0, totalMs: 0, answer: '' };
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
}

const passed = results.filter((r) => r.pass).length;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
if (runs > 1) {
  console.log('\nPer caso (giri superati):');
  for (const c of cases) {
    const mine = results.filter((r) => r.id === c.id);
    console.log(`  ${c.id.padEnd(26)} ${mine.filter((r) => r.pass).length}/${mine.length}`);
  }
}
console.log(
  `\nSuperati ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%) · tempo medio ${(avg(results.map((r) => r.totalMs)) / 1000).toFixed(1)} s` +
    ` · primo token in media ${(avg(results.map((r) => r.firstTokenMs)) / 1000).toFixed(1)} s`,
);
const withCites = results.filter((r) => r.cites !== null);
if (withCites.length) console.log(`Risposte sulla posta con citazioni: ${withCites.filter((r) => r.cites).length}/${withCites.length}`);

const outDir = path.join(here, '../eval/results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const file = path.join(outDir, `${stamp}-${config.ollama.llmModel.replace(/[^a-z0-9.-]+/gi, '_')}.json`);
fs.writeFileSync(file, JSON.stringify({ model: config.ollama.llmModel, numCtx: config.ollama.numCtx, runs, loadMs, passed, total: results.length, results }, null, 2));
console.log(`Risultati: ${path.relative(process.cwd(), file)}`);
sqlite.close();
