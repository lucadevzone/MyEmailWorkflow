// Correzioni retroattive sulla posta già importata, senza reimportare nulla: le mail originali e le
// etichette di Gmail sono già nel database. Gira una volta sola, in background, all'avvio del server.
//   1. date falsificate (es. anno 8496) → data di arrivo dall'intestazione Received;
//   2. conversazioni già archiviate su Gmail (nessun messaggio in Posta in arrivo) → archiviate anche qui;
//   3. News ricalcolate con il filtro nuovo, salvo quelle decise a mano.

import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { simpleParser } from 'mailparser';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';
import type { BlobStore } from '../store/blobs.ts';
import { now } from '../lib/ids.ts';
import { receivedDate } from '../ingest/dates.ts';
import { detectNoise } from '../ingest/noise.ts';
import { ruleFor } from '../rules/sender-rules.ts';
import { enqueueEmbedding } from '../ai/embed.ts';
import { enqueueSummary } from '../ai/summarize.ts';
import { enqueueClassification } from '../ai/classify.ts';
import { PRIORITY } from '../jobs/queue.ts';
import { bus } from '../events/bus.ts';

const KEY = 'maintenance.repair-2026-10';
/** Ricalcolo delle News da ripetere quando il filtro cambia (nuovi indizi): basta cambiare la chiave. */
const NOISE_KEY = 'maintenance.noise-v3';
const MIN = Date.UTC(1995, 0, 1);

/** Solo le intestazioni della mail originale: veloce anche con allegati pesanti. */
async function headersOf(blobs: BlobStore, sha: string): Promise<Map<string, unknown> | null> {
  try {
    const buf = blobs.read(sha);
    let end = buf.indexOf('\r\n\r\n');
    if (end < 0) end = buf.indexOf('\n\n');
    const head = end < 0 ? buf : buf.subarray(0, end + 2);
    return (await simpleParser(Buffer.concat([head, Buffer.from('\r\n\r\n')]))).headers;
  } catch {
    return null;
  }
}

const breathe = () => new Promise((r) => setImmediate(r));

export async function runRepairs(deps: { db: Db; sqlite: Database.Database; blobs: BlobStore }, log: (msg: string) => void) {
  const { db } = deps;
  const done = (key: string) => !!db.select().from(settings).where(eq(settings.key, key)).get();
  const mark = (key: string, value: unknown) => {
    const t = now();
    db.insert(settings).values({ key, value: JSON.stringify({ at: t, ...(value as object) }), updatedAt: t }).run();
  };
  if (!done(KEY)) mark(KEY, await repairOnce(deps, log));
  if (!done(NOISE_KEY)) mark(NOISE_KEY, await recomputeNoise(deps, log));
  bus.publish({ type: 'conversations', ids: [] });
  bus.publish({ type: 'projects' });
}

async function repairOnce(deps: { db: Db; sqlite: Database.Database; blobs: BlobStore }, log: (msg: string) => void) {
  const { sqlite, blobs } = deps;
  const t = now();

  // 1. Date assurde.
  const badDates = sqlite
    .prepare('select id, conversation_id as c, raw_blob_sha as sha, created_at as created from messages where deleted_at is null and (date > ? or date < ?)')
    .all(t + 2 * 86_400_000, MIN) as { id: string; c: string; sha: string | null; created: number }[];
  const touched = new Set<string>();
  for (const m of badDates) {
    const h = m.sha ? await headersOf(blobs, m.sha) : null;
    const date = (h && receivedDate(h)?.getTime()) || m.created;
    sqlite.prepare('update messages set date = ? where id = ?').run(date, m.id);
    touched.add(m.c);
  }
  for (const c of touched) {
    sqlite.prepare('update conversations set last_message_at = (select max(date) from messages where conversation_id = ? and deleted_at is null) where id = ?').run(c, c);
  }
  if (badDates.length) log(`Manutenzione: ${badDates.length} date falsificate corrette`);

  // 2. Già archiviate su Gmail (nessun messaggio con l'etichetta Posta in arrivo), fuori dai progetti.
  const archived = sqlite
    .prepare(
      `update conversations set archived_at = ?, updated_at = ?
        where deleted_at is null and archived_at is null and trashed_at is null and project_id is null
          and exists (select 1 from messages m where m.conversation_id = conversations.id and m.gm_msgid is not null and m.deleted_at is null)
          and not exists (select 1 from messages m where m.conversation_id = conversations.id and m.deleted_at is null and m.labels like '%Inbox%')`,
    )
    .run(t, t).changes;
  if (archived) log(`Manutenzione: ${archived} conversazioni già archiviate su Gmail archiviate anche qui`);

  return { badDates: badDates.length, archived };
}

/** News ricalcolate col filtro attuale (sul primo messaggio, come all'arrivo), salvo scelte manuali e regole. */
async function recomputeNoise(deps: { db: Db; sqlite: Database.Database; blobs: BlobStore }, log: (msg: string) => void) {
  const { db, sqlite, blobs } = deps;
  const t = now();
  const convs = sqlite
    .prepare(
      `select c.id, c.is_noise as noise, c.archived_at as archivedAt,
              (select m.raw_blob_sha from messages m where m.conversation_id = c.id and m.deleted_at is null and m.raw_blob_sha is not null order by m.date limit 1) as sha,
              (select m.from_address from messages m where m.conversation_id = c.id and m.deleted_at is null order by m.date limit 1) as sender,
              (select m.subject from messages m where m.conversation_id = c.id and m.deleted_at is null order by m.date limit 1) as subject
         from conversations c
        where c.deleted_at is null and c.project_id is null and c.noise_manual = 0 and c.is_spam = 0`,
    )
    .all() as { id: string; noise: number; archivedAt: number | null; sha: string | null; sender: string | null; subject: string | null }[];
  let toNews = 0;
  let fromNews = 0;
  for (const [i, c] of convs.entries()) {
    if (i % 200 === 0) await breathe();
    if (!c.sha) continue;
    const h = await headersOf(blobs, c.sha);
    if (!h) continue;
    const rule = ruleFor(db, c.sender);
    const isNoise = rule === 'news' ? true : rule === 'not_news' ? false : detectNoise({ headers: h, fromAddress: c.sender, subject: c.subject }).isNoise;
    if (isNoise === !!c.noise) continue;
    sqlite.prepare('update conversations set is_noise = ?, updated_at = ? where id = ?').run(isNoise ? 1 : 0, t, c.id);
    if (isNoise) {
      toNews++;
      continue;
    }
    fromNews++;
    // Uscita dalle News: ora va indicizzata e, se non è archiviata, riassunta e classificata.
    for (const m of sqlite.prepare('select id from messages where conversation_id = ? and deleted_at is null').all(c.id) as { id: string }[]) {
      enqueueEmbedding(db, m.id, PRIORITY.background);
    }
    if (!c.archivedAt) {
      enqueueSummary(db, c.id, PRIORITY.background);
      enqueueClassification(db, c.id, PRIORITY.background);
    }
  }
  if (toNews || fromNews) log(`Manutenzione: ${fromNews} conversazioni tolte dalle News, ${toNews} spostate nelle News`);
  return { fromNews, toNews };
}
