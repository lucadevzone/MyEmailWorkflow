// Ricerca unica (S5): conversazioni (parole + significato, fusi con Reciprocal Rank Fusion),
// allegati e risorse per nome, task e note per testo. Un solo ambito: tutto o un progetto.

import type Database from 'better-sqlite3';
import type { SearchConversationHit, SearchFileHit, SearchItemHit, SearchResults, SearchScope } from '@mmw/shared';
import type { Embedder } from '../ai/embed.ts';

const RRF_K = 60;
const MAX_CONVERSATIONS = 10;
const MAX_FILES = 8;
const MAX_ITEMS = 8;
/** Oltre questa distanza (coseno < ~0.5) un vicino non è considerato pertinente. */
const MAX_VEC_DISTANCE = 1.0;
const EMBED_TIMEOUT = 4000;

/** Parole della richiesta (almeno 2 caratteri), senza la punteggiatura che l'FTS interpreterebbe. */
export function searchTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 8);
}

/** Condizione SQL sull'ambito, applicata alla conversazione (alias c). */
function scopeSql(scope: SearchScope): { sql: string; params: unknown[] } {
  if (scope === 'inbox') return { sql: 'c.project_id is null and c.is_noise = 0', params: [] };
  if (scope === 'news') return { sql: 'c.project_id is null and c.is_noise = 1', params: [] };
  if (scope.startsWith('project:')) return { sql: 'c.project_id = ?', params: [scope.slice(8)] };
  return { sql: '1 = 1', params: [] };
}

const clip = (s: string, n = 180) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Brano attorno alla prima parola trovata (per i risultati che non vengono dall'FTS). */
function excerpt(text: string, terms: string[], n = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0), Infinity);
  if (!Number.isFinite(at) || at < n / 3) return clip(flat, n);
  const start = Math.max(0, at - 50);
  return `…${clip(flat.slice(start), n - 1)}`;
}

type FileRow = Omit<SearchFileHit, 'kind' | 'isNoise'> & { isNoise: number };

export class SearchService {
  private cache = new Map<string, Float32Array>();

  constructor(private deps: { sqlite: Database.Database; embedder: Embedder }) {}

  private async embedQuery(q: string): Promise<Float32Array | null> {
    const key = q.trim().toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    try {
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), EMBED_TIMEOUT));
      const [v] = await Promise.race([this.deps.embedder([q]), timeout]);
      if (!v) return null;
      const vec = new Float32Array(v);
      this.cache.set(key, vec);
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
      return vec;
    } catch {
      return null;
    }
  }

  /**
   * `loose` (per l'assistente): basta una delle parole e la soglia di significato è più ampia,
   * così anche una domanda scritta per intero trova le conversazioni pertinenti.
   */
  async search(q: string, scope: SearchScope = 'all', opts: { loose?: boolean } = {}): Promise<SearchResults> {
    const terms = searchTerms(q);
    const empty: SearchResults = { query: q, terms, conversations: [], files: [], items: [], semantic: false };
    if (!terms.length) return empty;
    const { sqlite } = this.deps;
    const where = scopeSql(scope);

    // 1. Parole: FTS5 con prefisso su ogni termine (tutte le parole devono esserci).
    const match = terms.map((t) => `"${t}"*`).join(opts.loose ? ' OR ' : ' ');
    const fts = sqlite
      .prepare(
        `select f.message_id as messageId, m.conversation_id as conversationId,
                snippet(message_fts, 2, '', '', '…', 18) as snip
           from message_fts f join messages m on m.id = f.message_id join conversations c on c.id = m.conversation_id
          where message_fts match ? and m.deleted_at is null and c.deleted_at is null and ${where.sql}
          order by bm25(message_fts, 0, 4, 1, 2) limit 60`,
      )
      .all(match, ...where.params) as { messageId: string; conversationId: string; snip: string }[];

    // 2. Significato: vicini del vettore della richiesta.
    const vec = await this.embedQuery(q);
    const vecHits = vec
      ? (sqlite
          .prepare(
            `with knn as (select chunk_id, distance from chunk_vec where embedding match ? and k = 60)
             select m.id as messageId, m.conversation_id as conversationId, ch.text as text, knn.distance as d
               from knn join chunks ch on ch.id = knn.chunk_id join messages m on m.id = ch.message_id
               join conversations c on c.id = m.conversation_id
              where m.deleted_at is null and c.deleted_at is null and knn.distance <= ? and ${where.sql}
              order by knn.distance`,
          )
          .all(vec, opts.loose ? MAX_VEC_DISTANCE * 1.2 : MAX_VEC_DISTANCE, ...where.params) as { messageId: string; conversationId: string; text: string; d: number }[])
      : [];

    // 3. Fusione per conversazione: il miglior messaggio di ciascuna lista conta una volta.
    const score = new Map<string, { s: number; messageId: string; snippet: string; best: number }>();
    const add = (conversationId: string, messageId: string, rank: number, snippet: string) => {
      const inc = 1 / (RRF_K + rank);
      const cur = score.get(conversationId);
      if (!cur) score.set(conversationId, { s: inc, messageId, snippet, best: inc });
      else {
        cur.s += inc;
        if (inc > cur.best) Object.assign(cur, { best: inc, messageId, snippet });
      }
    };
    const seen = (list: { conversationId: string }[]) => {
      const firsts: number[] = [];
      const got = new Set<string>();
      list.forEach((r, i) => {
        if (!got.has(r.conversationId)) {
          got.add(r.conversationId);
          firsts.push(i);
        }
      });
      return firsts;
    };
    seen(fts).forEach((i, rank) => add(fts[i]!.conversationId, fts[i]!.messageId, rank, fts[i]!.snip));
    seen(vecHits).forEach((i, rank) => add(vecHits[i]!.conversationId, vecHits[i]!.messageId, rank, excerpt(vecHits[i]!.text, terms)));
    const ranked = [...score.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, MAX_CONVERSATIONS);

    const convRow = sqlite.prepare(
      `select c.id, c.project_id as projectId, c.is_noise as isNoise, coalesce(c.summary, c.subject, '(nessun oggetto)') as title,
              c.last_message_at as date from conversations c where c.id = ?`,
    );
    const people = sqlite.prepare(
      `select coalesce(nullif(m.from_name, ''), null) as name, m.from_address as email from messages m
        where m.conversation_id = ? and m.direction = 'in' and m.deleted_at is null and m.from_address is not null
        group by lower(m.from_address) order by max(m.date) desc limit 3`,
    );
    const conversations: SearchConversationHit[] = ranked.map(([id, h]) => {
      const c = convRow.get(id) as { projectId: string | null; isNoise: number; title: string; date: number };
      return {
        conversationId: id,
        messageId: h.messageId,
        projectId: c.projectId,
        isNoise: !!c.isNoise,
        title: c.title,
        snippet: clip(h.snippet, 220),
        participants: people.all(id) as { name: string | null; email: string }[],
        date: c.date,
      };
    });

    // 4. Allegati (nome file, una volta per file per conversazione) e risorse (titolo).
    const like = terms.map(() => `lower(x) like ?`);
    const likeParams = terms.map((t) => `%${t}%`);
    const cond = (col: string) => like.map((l) => l.replace('x', col)).join(' and ');
    const atts = sqlite
      .prepare(
        `select a.id, a.filename as title, a.size, m.conversation_id as conversationId, c.project_id as projectId, c.is_noise as isNoise,
                coalesce(c.summary, c.subject, '') as context
           from attachments a join messages m on m.id = a.message_id join conversations c on c.id = m.conversation_id
          where a.is_inline = 0 and a.filename is not null and m.deleted_at is null and c.deleted_at is null
            and ${cond('a.filename')} and ${where.sql}
          group by m.conversation_id, lower(a.filename) order by max(m.date) desc limit ?`,
      )
      .all(...likeParams, ...where.params, MAX_FILES) as FileRow[];
    const resScope = where.sql.replaceAll('c.project_id', 'coalesce(c.project_id, r.project_id)');
    const res = sqlite
      .prepare(
        `select r.id, r.title, b.size, r.conversation_id as conversationId, coalesce(c.project_id, r.project_id) as projectId,
                coalesce(c.is_noise, 0) as isNoise, coalesce(c.summary, c.subject, p.name, '') as context
           from resources r left join conversations c on c.id = r.conversation_id left join projects p on p.id = r.project_id
           left join blobs b on b.sha256 = r.blob_sha
          where r.deleted_at is null and ${cond('r.title')} and ${resScope.replace('c.is_noise', 'coalesce(c.is_noise, 0)')}
          order by r.created_at desc limit ?`,
      )
      .all(...likeParams, ...where.params, MAX_FILES) as FileRow[];
    const files: SearchFileHit[] = [
      ...res.map((r) => ({ ...r, kind: 'resource' as const, isNoise: !!r.isNoise })),
      ...atts.map((a) => ({ ...a, kind: 'attachment' as const, isNoise: !!a.isNoise })),
    ].slice(0, MAX_FILES);

    // 5. Task (titolo e descrizione) e note (testo).
    const taskScope = resScope.replaceAll('r.project_id', 't.project_id');
    const tasks = sqlite
      .prepare(
        `select t.id, t.title, coalesce(t.details, '') as body, t.status, t.conversation_id as conversationId,
                coalesce(c.project_id, t.project_id) as projectId, coalesce(c.is_noise, 0) as isNoise
           from tasks t left join conversations c on c.id = t.conversation_id
          where t.deleted_at is null and ${terms.map(() => `lower(t.title || ' ' || coalesce(t.details, '')) like ?`).join(' and ')}
            and ${taskScope.replace('c.is_noise', 'coalesce(c.is_noise, 0)')}
          order by t.status = 'done', t.updated_at desc limit ?`,
      )
      .all(...likeParams, ...where.params, MAX_ITEMS) as { id: string; title: string; body: string; status: string; conversationId: string | null; projectId: string | null; isNoise: number }[];
    const noteScope = resScope.replaceAll('r.project_id', 'n.project_id');
    const notes = sqlite
      .prepare(
        `select n.id, n.body, n.conversation_id as conversationId, coalesce(c.project_id, n.project_id) as projectId, coalesce(c.is_noise, 0) as isNoise
           from notes n left join conversations c on c.id = n.conversation_id
          where n.deleted_at is null and ${cond('n.body')} and ${noteScope.replace('c.is_noise', 'coalesce(c.is_noise, 0)')}
          order by n.updated_at desc limit ?`,
      )
      .all(...likeParams, ...where.params, MAX_ITEMS) as { id: string; body: string; conversationId: string | null; projectId: string | null; isNoise: number }[];
    const items: SearchItemHit[] = [
      ...tasks.map((t) => ({
        kind: 'task' as const,
        id: t.id,
        title: t.title,
        snippet: t.body ? excerpt(t.body, terms, 140) : '',
        done: t.status === 'done',
        conversationId: t.conversationId,
        projectId: t.projectId,
        isNoise: !!t.isNoise,
      })),
      ...notes.map((n) => ({
        kind: 'note' as const,
        id: n.id,
        title: clip(n.body.split('\n')[0] ?? '', 90),
        snippet: excerpt(n.body, terms, 140),
        done: false,
        conversationId: n.conversationId,
        projectId: n.projectId,
        isNoise: !!n.isNoise,
      })),
    ].slice(0, MAX_ITEMS);

    return { query: q, terms, conversations, files, items, semantic: !!vec };
  }
}
