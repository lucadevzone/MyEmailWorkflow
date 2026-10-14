// Scambio dei dati personali tra PC (uso alternato, docs/03-uso-su-piu-pc.md).
//
// L'archivio della posta resta su ogni PC (si ricostruisce da Gmail); viaggiano solo i dati personali:
// progetti, categorie, firme, regole, contatti, task, note, bozze, chat, coda delle attività, e per ogni
// conversazione il suo stato (progetto, archiviata, News/Spam, sintesi…) più la mappa messaggio →
// conversazione. I codici delle conversazioni sono comuni tra i PC; i messaggi si riconoscono dalla chiave
// stabile (messages.stable_key) e all'import tornano ai codici locali.
//
// Il file di scambio è un piccolo database SQLite (exportPersonal). importPersonal lo applica: sostituisce
// i dati personali locali (un solo PC scrive alla volta: vince l'ultimo consegnato) e riordina i messaggi
// locali nelle conversazioni indicate. I riferimenti a posta non ancora arrivata su questo PC restano in
// sospeso (shared_pending_refs, shared_message_map, shared_conversation_state) e si completano quando
// arriva.

import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import type Database from 'better-sqlite3';
import { normalizeSubject } from '../ingest/clean-text.ts';

export const EXCHANGE_FORMAT = 1;

/** Tabelle personali copiate così come sono (non contengono riferimenti ai messaggi locali). */
const PLAIN_TABLES = [
  'accounts',
  'signatures',
  'project_categories',
  'projects',
  'contacts',
  'contact_groups',
  'group_members',
  'project_contacts',
  'project_groups',
  'sender_rules',
  'auto_sort_log',
  'assistant_messages',
] as const;

/**
 * Tabelle personali con riferimenti alla posta: colonna → tipo di riferimento. I messaggi viaggiano come
 * chiave stabile; conversazioni e file (blob) con il loro codice, ma localmente possono mancare.
 */
const REF_TABLES: Record<string, Record<string, 'message' | 'conversation' | 'blob'>> = {
  annotations: { message_id: 'message' },
  tasks: { conversation_id: 'conversation', message_id: 'message' },
  notes: { conversation_id: 'conversation', message_id: 'message' },
  resources: { conversation_id: 'conversation', blob_sha: 'blob' },
  drafts: { conversation_id: 'conversation', reply_to_message_id: 'message', forward_message_id: 'message' },
};

/** Ordine di inserimento (rispetta i vincoli): prima ciò a cui gli altri fanno riferimento. */
const INSERT_ORDER = [...PLAIN_TABLES, 'annotations', 'tasks', 'notes', 'resources', 'drafts'];

/** Stato personale di una conversazione (il resto, come oggetto e data, viene dalla posta locale). */
const CONV_STATE_COLS = [
  'id',
  'project_id',
  'summary',
  'summary_detailed',
  'summary_updated_at',
  'last_message_at',
  'archived_at',
  'trashed_at',
  'is_noise',
  'noise_manual',
  'is_spam',
  'split_from_id',
  'split_at',
  'auto_sorted_at',
  'created_at',
  'updated_at',
];

/** Impostazioni di questo PC: non viaggiano. */
const LOCAL_SETTING_KEYS = ['llmModel', 'ollamaKeepAliveMinutes', 'aiPaused'];
const LOCAL_SETTING_PREFIXES = ['maintenance.', 'exchange.', 'machine.'];
const isLocalSetting = (key: string) => LOCAL_SETTING_KEYS.includes(key) || LOCAL_SETTING_PREFIXES.some((p) => key.startsWith(p));

/**
 * Impronta della chiave stabile di un messaggio (16 caratteri invece di ~90): nel file di scambio la mappa
 * dei messaggi è la parte più grande. Con decine di migliaia di messaggi le collisioni sono trascurabili.
 */
export function messageKeyHash(stableKey: string): string {
  return crypto.createHash('sha256').update(stableKey).digest('hex').slice(0, 16);
}

/** Tabelle locali che conservano ciò che non si è ancora potuto applicare. */
export function ensureExchangeTables(sqlite: Database.Database) {
  sqlite.function('mmw_key', { deterministic: true }, (k: unknown) => (typeof k === 'string' ? messageKeyHash(k) : null));
  sqlite.exec(`
    create table if not exists shared_message_map (stable_key text primary key, conversation_id text not null);
    create table if not exists shared_conversation_state (${CONV_STATE_COLS.map((c) => (c === 'id' ? 'id text primary key' : `${c}`)).join(', ')});
    create table if not exists shared_pending_refs (
      tbl text not null, row_id text not null, col text not null, kind text not null, ref text not null,
      primary key (tbl, row_id, col)
    );
    create table if not exists shared_pending_rows (tbl text not null, row_id text not null, row_json text not null, ref text not null, primary key (tbl, row_id));
  `);
}

const cols = (sqlite: Database.Database, schema: string, table: string): string[] =>
  (sqlite.prepare(`pragma ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface ExportInfo {
  version: number;
  machine: string;
  exportedAt: number;
}

/** Scrive i dati personali in un nuovo file SQLite (sovrascrive se esiste). */
export function exportPersonal(sqlite: Database.Database, file: string, info: ExportInfo) {
  ensureExchangeTables(sqlite);
  fs.rmSync(file, { force: true });
  sqlite.prepare('attach database ? as x').run(file);
  try {
    sqlite.transaction(() => {
      sqlite.exec(`create table x.meta (key text primary key, value text)`);
      const meta = sqlite.prepare('insert into x.meta values (?, ?)');
      meta.run('format', String(EXCHANGE_FORMAT));
      meta.run('version', String(info.version));
      meta.run('machine', info.machine);
      meta.run('exported_at', String(info.exportedAt));

      for (const t of PLAIN_TABLES) sqlite.exec(`create table x.${t} as select * from main.${t}`);
      // Impostazioni comuni (non quelle di questo PC).
      sqlite.exec(`create table x.settings as select * from main.settings where 0`);
      const ins = sqlite.prepare('insert into x.settings select * from main.settings where key = ?');
      for (const r of sqlite.prepare('select key from main.settings').all() as { key: string }[]) if (!isLocalSetting(r.key)) ins.run(r.key);

      // Tabelle con riferimenti alla posta: i messaggi diventano chiavi stabili (anche quelli ancora in sospeso).
      for (const [t, refs] of Object.entries(REF_TABLES)) {
        const select = cols(sqlite, 'main', t)
          .map((c) => {
            if (refs[c] === 'message') {
              return `coalesce((select mmw_key(m.stable_key) from main.messages m where m.id = t.${q(c)}),
                (select p.ref from main.shared_pending_refs p where p.tbl = '${t}' and p.row_id = t.id and p.col = '${c}')) as ${q(c)}`;
            }
            if (refs[c]) return `coalesce(t.${q(c)}, (select p.ref from main.shared_pending_refs p where p.tbl = '${t}' and p.row_id = t.id and p.col = '${c}')) as ${q(c)}`;
            return `t.${q(c)}`;
          })
          .join(', ');
        sqlite.exec(`create table x.${t} as select ${select} from main.${t} t`);
      }
      // Righe ancora in sospeso dall'ultimo import (es. annotazioni su messaggi non ancora arrivati).
      for (const r of sqlite.prepare('select tbl, row_json from main.shared_pending_rows').all() as { tbl: string; row_json: string }[]) {
        const row = JSON.parse(r.row_json) as Record<string, unknown>;
        const keys = Object.keys(row);
        sqlite.prepare(`insert into x.${r.tbl} (${keys.map(q).join(', ')}) values (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k] as never));
      }

      // Stato personale delle conversazioni: quelle locali e quelle note solo dall'altro PC.
      const sel = CONV_STATE_COLS.map(q).join(', ');
      sqlite.exec(`create table x.conv_state as select ${sel} from main.conversations where deleted_at is null`);
      sqlite.exec(`insert into x.conv_state select ${sel} from main.shared_conversation_state s
        where not exists (select 1 from main.conversations c where c.id = s.id)`);
      // Mappa messaggio → conversazione.
      // Ordinata per conversazione: i codici ripetuti si comprimono meglio.
      sqlite.exec(`create table x.msg_map as select mmw_key(stable_key) as stable_key, conversation_id from main.messages
        where deleted_at is null and stable_key is not null order by conversation_id`);
      sqlite.exec(`insert or ignore into x.msg_map select stable_key, conversation_id from main.shared_message_map s
        where not exists (select 1 from x.msg_map m where m.stable_key = s.stable_key)`);
      // Contatti confermati: i loro indirizzi.
      sqlite.exec(`create table x.contact_emails as select email, contact_id, display_name from main.contact_addresses where contact_id is not null`);
      // Metadati dei file a cui i dati personali fanno riferimento (i file viaggiano a parte).
      sqlite.exec(`create table x.blob_rows as select * from main.blobs where sha256 in (
        select blob_sha from main.resources where blob_sha is not null union select avatar_blob_sha from main.contacts where avatar_blob_sha is not null)`);

      // Coda delle attività ancora da eseguire (es. invii): con i messaggi in uscita che servono.
      sqlite.exec(`create table x.activities as select * from main.activities where status in ('pending', 'running', 'failed')`);
      const rows = sqlite.prepare('select id, payload from x.activities').all() as { id: string; payload: string }[];
      const keyOf = sqlite.prepare('select mmw_key(stable_key) as k from main.messages where id = ?');
      const outIds = new Set<string>();
      for (const r of rows) {
        const p = JSON.parse(r.payload) as { messageId?: string; messageIds?: string[] };
        if (p.messageId) {
          outIds.add(p.messageId);
          p.messageId = (keyOf.get(p.messageId) as { k: string } | undefined)?.k ?? p.messageId;
        }
        if (p.messageIds) p.messageIds = p.messageIds.map((id) => (keyOf.get(id) as { k: string } | undefined)?.k ?? id);
        sqlite.prepare("update x.activities set payload = ?, status = case status when 'running' then 'pending' else status end where id = ?").run(JSON.stringify(p), r.id);
      }
      sqlite.exec(`create table x.out_messages as select * from main.messages where 0`);
      const insOut = sqlite.prepare(`insert into x.out_messages select * from main.messages where id = ? and direction = 'out' and outgoing_status in ('queued', 'failed')`);
      for (const id of outIds) insOut.run(id);
    })();
  } finally {
    sqlite.prepare('detach database x').run();
  }
}

export interface ImportResult {
  version: number;
  machine: string;
  /** Messaggi locali spostati in un'altra conversazione per seguire la mappa. */
  movedMessages: number;
  /** Riferimenti a posta non ancora arrivata su questo PC. */
  pendingRefs: number;
  pendingConversations: number;
}

/** Applica un file di scambio al database locale. */
export function importPersonal(sqlite: Database.Database, file: string): ImportResult {
  ensureExchangeTables(sqlite);
  sqlite.prepare('attach database ? as x').run(file);
  try {
    const meta = Object.fromEntries((sqlite.prepare('select key, value from x.meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    if (Number(meta.format) !== EXCHANGE_FORMAT) throw new Error(`Formato del file di scambio non supportato (${meta.format})`);
    let moved = 0;
    // Indici sulla copia locale del file (il file che viaggia non li ha, per restare piccolo).
    sqlite.exec(`create index if not exists x.conv_state_id on conv_state(id);
      create index if not exists x.msg_map_key on msg_map(stable_key);
      create index if not exists x.msg_map_conv on msg_map(conversation_id);
      create index if not exists x.contact_emails_email on contact_emails(email);`);
    // Impronte delle chiavi dei messaggi locali, una volta sola.
    sqlite.exec(`drop table if exists temp.local_keys;
      create temp table local_keys (k text primary key, id text not null);
      insert or ignore into temp.local_keys select mmw_key(stable_key), id from main.messages where deleted_at is null and stable_key is not null`);
    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');
      const now = Date.now();

      // 1. Mappa messaggio → conversazione e stato delle conversazioni: conservati per la posta che arriverà.
      sqlite.exec(`delete from main.shared_message_map; insert into main.shared_message_map select stable_key, conversation_id from x.msg_map`);
      const sel = CONV_STATE_COLS.map(q).join(', ');
      sqlite.exec(`delete from main.shared_conversation_state; insert into main.shared_conversation_state (${sel}) select ${sel} from x.conv_state`);

      // Messaggi in uscita ancora da inviare (esistono solo sul PC che li ha scritti): servono alla coda.
      {
        const exists = sqlite.prepare('select 1 from main.messages where stable_key = ?');
        const outCols = cols(sqlite, 'x', 'out_messages').filter((n) => cols(sqlite, 'main', 'messages').includes(n));
        for (const m of sqlite.prepare('select * from x.out_messages').all() as Record<string, unknown>[]) {
          if (exists.get(m.stable_key)) continue;
          sqlite.prepare(`insert into main.messages (${outCols.map(q).join(', ')}) values (${outCols.map(() => '?').join(', ')})`).run(...outCols.map((c) => m[c] as never));
          sqlite.prepare('insert or ignore into temp.local_keys values (mmw_key(?), ?)').run(m.stable_key as string, m.id as string);
        }
      }

      // 2. Conversazioni: si creano quelle indicate dalla mappa che hanno messaggi qui, si spostano i messaggi.
      // Messaggio locale → conversazione indicata dalla mappa.
      sqlite.exec(`drop table if exists temp.target; create temp table target (id text primary key, conversation_id text not null);
        insert into temp.target select lk.id, mm.conversation_id from temp.local_keys lk join x.msg_map mm on mm.stable_key = lk.k`);
      const created = sqlite
        .prepare(
          `select s.id from x.conv_state s where not exists (select 1 from main.conversations c where c.id = s.id)
             and exists (select 1 from temp.target t where t.conversation_id = s.id)`,
        )
        .all() as { id: string }[];
      sqlite.exec(`
        insert into main.conversations (${sel})
        select ${CONV_STATE_COLS.map((c) => `s.${q(c)}`).join(', ')} from x.conv_state s
        where not exists (select 1 from main.conversations c where c.id = s.id)
          and exists (select 1 from temp.target t where t.conversation_id = s.id)`);
      moved = sqlite
        .prepare(
          `update main.messages set conversation_id = (select t.conversation_id from temp.target t where t.id = messages.id), updated_at = ?
           where id in (select id from temp.target)
             and conversation_id <> (select t.conversation_id from temp.target t where t.id = messages.id)`,
        )
        .run(now).changes;
      // L'oggetto non viaggia: lo si prende dal primo messaggio locale.
      const firstSubject = sqlite.prepare('select subject from main.messages where conversation_id = ? and deleted_at is null order by date limit 1');
      const setSubject = sqlite.prepare('update main.conversations set subject = ? where id = ?');
      for (const { id } of created) setSubject.run(normalizeSubject((firstSubject.get(id) as { subject: string | null } | undefined)?.subject) || null, id);
      // Stato personale delle conversazioni presenti qui.
      sqlite.exec(`
        update main.conversations set ${CONV_STATE_COLS.filter((c) => !['id', 'last_message_at', 'created_at'].includes(c))
          .map((c) => `${q(c)} = s.${q(c)}`)
          .join(', ')}
        from x.conv_state s where s.id = conversations.id`);
      // Conversazioni locali rimaste senza messaggi (assorbite in quelle comuni): spariscono.
      const emptied = sqlite
        .prepare(`select id from main.conversations c where deleted_at is null and not exists (select 1 from main.messages m where m.conversation_id = c.id and m.deleted_at is null)`)
        .all() as { id: string }[];
      for (const { id } of emptied) {
        sqlite.prepare('update main.attachments set version_chain_id = null, version_no = null where version_chain_id in (select id from main.version_chains where conversation_id = ?)').run(id);
        sqlite.prepare('delete from main.version_chains where conversation_id = ?').run(id);
        sqlite.prepare("delete from main.suggestions where subject_type = 'conversation' and subject_id = ?").run(id);
        sqlite.prepare('update main.conversations set deleted_at = ?, updated_at = ? where id = ?').run(now, now, id);
      }
      // Ultimo messaggio delle conversazioni toccate.
      sqlite.exec(`update main.conversations set last_message_at = coalesce((select max(m.date) from main.messages m where m.conversation_id = conversations.id and m.deleted_at is null), last_message_at)
        where id in (select id from x.conv_state)`);

      // 3. Dati personali: sostituiti da quelli consegnati (un solo PC scrive alla volta).
      sqlite.exec('delete from main.shared_pending_refs; delete from main.shared_pending_rows');
      for (const t of [...INSERT_ORDER].reverse()) sqlite.exec(`delete from main.${t}`);
      for (const t of PLAIN_TABLES) {
        const c = cols(sqlite, 'x', t).filter((n) => cols(sqlite, 'main', t).includes(n)).map(q).join(', ');
        sqlite.exec(`insert into main.${t} (${c}) select ${c} from x.${t}`);
      }
      // File (metadati) prima delle risorse che li usano.
      sqlite.exec(`insert or ignore into main.blobs select * from x.blob_rows`);
      for (const t of ['annotations', 'tasks', 'notes', 'resources', 'drafts']) insertWithRefs(sqlite, t);

      // Conversazioni locali assegnate a un progetto che non c'è più: tornano in Da smistare.
      sqlite.exec(`update main.conversations set project_id = null where project_id is not null and project_id not in (select id from main.projects)`);

      // Impostazioni comuni (quelle di questo PC restano).
      sqlite.exec(`delete from main.settings where key in (select key from x.settings)`);
      sqlite.exec(`insert into main.settings select * from x.settings`);

      // Contatti: indirizzi confermati.
      sqlite.exec(`update main.contact_addresses set contact_id = null where contact_id is not null`);
      sqlite.exec(`update main.contact_addresses set contact_id = e.contact_id from x.contact_emails e where e.email = contact_addresses.email`);
      const missing = sqlite.prepare(`select email, contact_id, display_name from x.contact_emails e where not exists (select 1 from main.contact_addresses a where a.email = e.email)`).all() as {
        email: string;
        contact_id: string;
        display_name: string | null;
      }[];
      const insAddr = sqlite.prepare('insert into main.contact_addresses (id, contact_id, email, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?)');
      for (const a of missing) insAddr.run(`ca-${a.contact_id}-${a.email}`, a.contact_id, a.email, a.display_name, now, now);

      // 4. Coda delle attività: quella consegnata sostituisce le attività locali non concluse.
      const keyToId = sqlite.prepare('select id from temp.local_keys where k = ?');
      sqlite.exec(`delete from main.activities where status in ('pending', 'running', 'failed')`);
      const actCols = cols(sqlite, 'x', 'activities').map(q).join(', ');
      for (const a of sqlite.prepare('select * from x.activities').all() as { id: string; payload: string }[]) {
        const p = JSON.parse(a.payload) as { messageId?: string; messageIds?: string[] };
        const idOf = (k: string) => (keyToId.get(k) as { id: string } | undefined)?.id ?? k;
        if (p.messageId) p.messageId = idOf(p.messageId);
        if (p.messageIds) p.messageIds = p.messageIds.map(idOf);
        sqlite.prepare(`insert into main.activities (${actCols}) select ${actCols} from x.activities where id = ?`).run(a.id);
        sqlite.prepare('update main.activities set payload = ? where id = ?').run(JSON.stringify(p), a.id);
      }

      // Versione importata (impostazione di questo PC).
      sqlite.prepare(`insert into main.settings (key, value, updated_at) values ('exchange.version', ?, ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(Number(meta.version)), now);
    })();
    const pendingRefs = (sqlite.prepare('select count(*) as n from main.shared_pending_refs').get() as { n: number }).n;
    const pendingRows = (sqlite.prepare('select count(*) as n from main.shared_pending_rows').get() as { n: number }).n;
    const pendingConversations = (
      sqlite.prepare('select count(*) as n from main.shared_conversation_state s where not exists (select 1 from main.conversations c where c.id = s.id)').get() as { n: number }
    ).n;
    return { version: Number(meta.version), machine: meta.machine ?? '', movedMessages: moved, pendingRefs: pendingRefs + pendingRows, pendingConversations };
  } finally {
    sqlite.prepare('detach database x').run();
  }
}

/**
 * Inserisce le righe di una tabella con riferimenti alla posta, traducendo le chiavi dei messaggi nei
 * codici locali. Un riferimento che qui non si risolve diventa NULL e resta in sospeso; se la colonna è
 * obbligatoria, l'intera riga resta in sospeso.
 */
function insertWithRefs(sqlite: Database.Database, t: string) {
  const refs = REF_TABLES[t]!;
  const mainCols = cols(sqlite, 'main', t);
  const notNull = new Set(
    (sqlite.prepare(`pragma main.table_info(${t})`).all() as { name: string; notnull: number }[]).filter((c) => c.notnull).map((c) => c.name),
  );
  const keyToId = sqlite.prepare('select id from temp.local_keys where k = ?');
  const convExists = sqlite.prepare('select 1 from main.conversations where id = ? and deleted_at is null');
  const blobExists = sqlite.prepare('select 1 from main.blobs where sha256 = ?');
  const rowExists = (tbl: string, id: string) => !!sqlite.prepare(`select 1 from main.${tbl} where id = ?`).get(id);
  const ins = sqlite.prepare(`insert into main.${t} (${mainCols.map(q).join(', ')}) values (${mainCols.map(() => '?').join(', ')})`);
  const pendRef = sqlite.prepare('insert or replace into main.shared_pending_refs (tbl, row_id, col, kind, ref) values (?, ?, ?, ?, ?)');
  const pendRow = sqlite.prepare('insert or replace into main.shared_pending_rows (tbl, row_id, row_json, ref) values (?, ?, ?, ?)');

  for (const row of sqlite.prepare(`select * from x.${t}`).all() as Record<string, unknown>[]) {
    const out: Record<string, unknown> = { ...row };
    const pending: { col: string; kind: string; ref: string }[] = [];
    let wholeRowPending: string | null = null;
    for (const [col, kind] of Object.entries(refs)) {
      const v = row[col] as string | null;
      if (v == null) continue;
      const ok = kind === 'message' ? (keyToId.get(v) as { id: string } | undefined)?.id : kind === 'conversation' ? (convExists.get(v) ? v : undefined) : blobExists.get(v) ? v : undefined;
      if (ok) {
        out[col] = ok;
        continue;
      }
      if (notNull.has(col)) wholeRowPending = v;
      out[col] = null;
      pending.push({ col, kind, ref: v });
    }
    // Annotazione rimasta in sospeso: anche chi la usa la perde finché non arriva il messaggio.
    for (const c of ['annotation_id']) {
      const v = out[c] as string | null | undefined;
      if (v && !rowExists('annotations', v)) {
        out[c] = null;
        pending.push({ col: c, kind: 'annotation', ref: v });
      }
    }
    if (wholeRowPending) {
      pendRow.run(t, row.id as string, JSON.stringify(row), wholeRowPending);
      continue;
    }
    ins.run(...mainCols.map((c) => out[c] as never));
    for (const p of pending) pendRef.run(t, row.id as string, p.col, p.kind, p.ref);
  }
}

/** Comprime e decomprime il file di scambio per il viaggio nel cloud. */
export function gzipFile(src: string, dest: string) {
  fs.writeFileSync(dest, zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
}
export function gunzipFile(src: string, dest: string) {
  fs.writeFileSync(dest, zlib.gunzipSync(fs.readFileSync(src)));
}
