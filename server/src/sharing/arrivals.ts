// Posta che arriva dopo l'import dei dati personali (fase 3, docs/03-uso-su-piu-pc.md).
//
// Sul PC che prende il database la posta può non esserci ancora (la prima volta, o dopo giorni): l'import
// conserva la mappa messaggio → conversazione, lo stato delle conversazioni e i riferimenti in sospeso.
// Quando un messaggio arriva da Gmail, la mappa decide la sua conversazione (che nasce con progetto,
// archiviazione, sintesi… decisi sull'altro PC) e i task, le note e le bozze che lo aspettavano lo ritrovano.

import type Database from 'better-sqlite3';
import { normalizeSubject } from '../ingest/clean-text.ts';
import { CONV_STATE_COLS, messageKeyHash, placeRow } from './exchange.ts';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface MappedConversation {
  /** Codice comune della conversazione indicata dall'altro PC. */
  id: string;
  /** Hash della chiave stabile del messaggio (come viaggia nel file di scambio). */
  keyHash: string;
}

/** La conversazione in cui l'altro PC ha messo questo messaggio, se la mappa lo conosce. */
export function mappedConversation(sqlite: Database.Database, stableKey: string): MappedConversation | null {
  const keyHash = messageKeyHash(stableKey);
  const r = sqlite.prepare('select conversation_id as id from shared_message_map where stable_key = ?').get(keyHash) as { id: string } | undefined;
  return r ? { id: r.id, keyHash } : null;
}

/**
 * Prepara la conversazione indicata dalla mappa: se c'è già la si usa; altrimenti nasce (o rinasce, se era
 * stata svuotata) con lo stato consegnato dall'altro PC. Restituisce false se non la si può preparare.
 */
export function ensureMappedConversation(sqlite: Database.Database, id: string, o: { subject: string | null; gmThreadId: string | null }): boolean {
  const cur = sqlite.prepare('select deleted_at as d from conversations where id = ?').get(id) as { d: number | null } | undefined;
  if (cur && cur.d == null) return true;
  const state = sqlite.prepare('select * from shared_conversation_state where id = ?').get(id) as Record<string, unknown> | undefined;
  if (!state) return false;
  // Un progetto che qui non c'è (rimosso dopo la consegna): la conversazione va in Da smistare.
  if (state.project_id && !sqlite.prepare('select 1 from projects where id = ?').get(state.project_id)) state.project_id = null;
  const subject = normalizeSubject(o.subject) || null;
  if (cur) {
    const set = CONV_STATE_COLS.filter((c) => c !== 'id');
    sqlite
      .prepare(`update conversations set ${set.map((c) => `${q(c)} = ?`).join(', ')}, subject = coalesce(subject, ?), gm_thread_id = coalesce(gm_thread_id, ?), deleted_at = null where id = ?`)
      .run(...set.map((c) => state[c] as never), subject, o.gmThreadId, id);
  } else {
    const c = [...CONV_STATE_COLS];
    sqlite
      .prepare(`insert into conversations (${[...c, 'subject', 'gm_thread_id'].map(q).join(', ')}) values (${[...c, 'subject', 'gm_thread_id'].map(() => '?').join(', ')})`)
      .run(...c.map((k) => state[k] as never), subject, o.gmThreadId);
  }
  return true;
}

export interface ArrivalResult {
  /** Righe (task, note, annotazioni, bozze, risorse) completate o inserite. */
  resolved: number;
  tables: Set<string>;
}

/**
 * Il messaggio (codice locale messageId, chiave keyHash) è arrivato nella conversazione conversationId:
 * si completano i riferimenti che lo aspettavano, e quelli che aspettavano la conversazione.
 */
export function resolveArrival(sqlite: Database.Database, a: { keyHash: string; messageId: string; conversationId: string }): ArrivalResult {
  const out: ArrivalResult = { resolved: 0, tables: new Set() };
  const hasPending = sqlite.prepare('select 1 from shared_pending_refs where ref in (?, ?) union all select 1 from shared_pending_rows where ref in (?, ?) limit 1');
  if (!hasPending.get(a.keyHash, a.conversationId, a.keyHash, a.conversationId)) return out;

  sqlite.transaction(() => {
    // Righe intere in attesa (per esempio un'annotazione, che non esiste senza il suo messaggio).
    const rows = sqlite.prepare('select tbl, row_id, row_json from shared_pending_rows where ref in (?, ?)').all(a.keyHash, a.conversationId) as {
      tbl: string;
      row_id: string;
      row_json: string;
    }[];
    for (const r of rows) {
      sqlite.prepare('delete from shared_pending_rows where tbl = ? and row_id = ?').run(r.tbl, r.row_id);
      if (placeRow(sqlite, r.tbl, JSON.parse(r.row_json) as Record<string, unknown>, (k) => (k === a.keyHash ? a.messageId : localIdOf(sqlite, k)))) {
        out.resolved++;
        out.tables.add(r.tbl);
        // Chi usava l'annotazione la ritrova.
        if (r.tbl === 'annotations') fill(sqlite, 'annotation', r.row_id, r.row_id, out);
      }
    }
    // Singoli riferimenti.
    fill(sqlite, 'message', a.keyHash, a.messageId, out);
    fill(sqlite, 'conversation', a.conversationId, a.conversationId, out);
  })();
  return out;
}

function fill(sqlite: Database.Database, kind: string, ref: string, value: string, out: ArrivalResult) {
  const refs = sqlite.prepare('select tbl, row_id, col from shared_pending_refs where kind = ? and ref = ?').all(kind, ref) as { tbl: string; row_id: string; col: string }[];
  for (const p of refs) {
    sqlite.prepare(`update ${p.tbl} set ${q(p.col)} = ? where id = ?`).run(value, p.row_id);
    sqlite.prepare('delete from shared_pending_refs where tbl = ? and row_id = ? and col = ?').run(p.tbl, p.row_id, p.col);
    out.resolved++;
    out.tables.add(p.tbl);
  }
}

/** Codice locale di un messaggio dalla sua impronta (caso raro: si scorrono le chiavi). */
function localIdOf(sqlite: Database.Database, keyHash: string): string | undefined {
  const all = sqlite.prepare('select id, stable_key as k from messages where deleted_at is null and stable_key is not null').iterate() as Iterable<{ id: string; k: string }>;
  for (const m of all) if (messageKeyHash(m.k) === keyHash) return m.id;
  return undefined;
}
