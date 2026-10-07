// Sviluppo: stampa le sintesi che l'LLM produrrebbe per le conversazioni (non rumore), senza salvarle.
// Uso: pnpm --filter @mmw/server try:summary [numero massimo]
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema.ts';
import { config } from '../src/config.ts';
import { buildSummaryPrompt, ollamaSummarizer } from '../src/ai/summarize.ts';
import type { Db } from '../src/db/client.ts';

const sqlite = new Database(config.dbPath, { readonly: true });
sqliteVec.load(sqlite);
const db = drizzle(sqlite, { schema }) as unknown as Db;
const max = Number(process.argv[2] ?? 5);
const rows = sqlite
  .prepare('select id, subject from conversations where deleted_at is null and is_noise = 0 order by last_message_at desc limit ?')
  .all(max) as { id: string; subject: string }[];

for (const r of rows) {
  const t = Date.now();
  const out = await ollamaSummarizer(buildSummaryPrompt(db, r.id)!);
  console.log(`== ${r.subject} (${((Date.now() - t) / 1000).toFixed(1)}s, ${config.ollama.llmModel})`);
  console.log(`BREVE: ${out.breve}\nDETTAGLIATA: ${out.dettagliata}\n`);
}
