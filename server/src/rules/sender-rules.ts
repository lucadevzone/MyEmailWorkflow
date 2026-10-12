// Regole per mittente: "è / non è una News", "è / non è Spam" ricordano la scelta per la posta futura
// e propongono di applicarla anche a quella già arrivata. Una regola vale per un indirizzo esatto o per
// un dominio (con i suoi sottodomini); la più specifica vince.

import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { SenderRuleKind, SenderRuleResultDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { senderRules } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { enqueueEmbedding } from '../ai/embed.ts';
import { enqueueSummary } from '../ai/summarize.ts';
import { enqueueClassification } from '../ai/classify.ts';
import { PRIORITY } from '../jobs/queue.ts';

export class RuleError extends Error {}

/** Indirizzo esatto, dominio (@updates.itch.io) o dominio principale (@itch.io) del mittente. */
export function patternFor(address: string, scope: 'address' | 'domain' | 'root'): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at < 0) throw new RuleError('Indirizzo del mittente non valido');
  if (scope === 'address') return a;
  if (scope === 'domain') return a.slice(at);
  return `@${a.slice(at + 1).split('.').slice(-2).join('.')}`;
}

/** Candidati dal più specifico: l'indirizzo, poi il dominio e i domini padre (@updates.itch.io, @itch.io). */
function candidates(address: string): string[] {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at < 0) return [a];
  const parts = a.slice(at + 1).split('.');
  const domains = parts.slice(0, -1).map((_, i) => `@${parts.slice(i).join('.')}`);
  return [a, ...domains];
}

/** La regola che vale per questo mittente, se c'è. */
export function ruleFor(db: Db, address: string | null): SenderRuleKind | null {
  if (!address) return null;
  for (const p of candidates(address)) {
    const r = db.select({ kind: senderRules.kind }).from(senderRules).where(eq(senderRules.pattern, p)).get();
    if (r) return r.kind;
  }
  return null;
}

/** Crea (o sostituisce) la regola per quel pattern. */
export function saveRule(db: Db, pattern: string, kind: SenderRuleKind): string {
  db.delete(senderRules).where(eq(senderRules.pattern, pattern)).run();
  const id = newId();
  db.insert(senderRules).values({ id, pattern, kind, createdAt: now() }).run();
  return id;
}

/** Mittente di una conversazione: chi ha scritto il primo messaggio arrivato. */
export function senderOfConversation(sqlite: Database.Database, conversationId: string): string | null {
  const r = sqlite
    .prepare(`select lower(from_address) as a from messages where conversation_id = ? and direction = 'in' and deleted_at is null and from_address is not null order by date limit 1`)
    .get(conversationId) as { a: string } | undefined;
  return r?.a ?? null;
}

/** Condizione SQL "la conversazione sta dalla parte sbagliata per questa regola". */
function wrongSide(kind: SenderRuleKind): string {
  switch (kind) {
    case 'news':
      return 'c.is_noise = 0 and c.is_spam = 0 and c.project_id is null';
    case 'not_news':
      return 'c.is_noise = 1';
    case 'spam':
      return 'c.is_spam = 0 and c.project_id is null';
    case 'not_spam':
      return 'c.is_spam = 1';
  }
}

/** Altre conversazioni a cui la regola si applicherebbe (esclusa quella da cui è nata). */
export function previewRule(sqlite: Database.Database, pattern: string, kind: SenderRuleKind, exclude: string, limit = 1000): Omit<SenderRuleResultDto, 'ruleId'> {
  const match = pattern.startsWith('@') ? `(s.a like ? or s.a like ?)` : `s.a = ?`;
  const params = pattern.startsWith('@') ? [`%${pattern}`, `%.${pattern.slice(1)}`] : [pattern];
  const base = `
    with s as (
      select c.id as id, c.subject as subject, c.last_message_at as date,
             (select lower(m.from_address) from messages m where m.conversation_id = c.id and m.direction = 'in' and m.deleted_at is null and m.from_address is not null order by m.date limit 1) as a
        from conversations c
       where c.deleted_at is null and c.trashed_at is null and c.id <> ? and ${wrongSide(kind)}
    )
    select id as conversationId, subject, a as "from", date from s where ${match}`;
  const total = (sqlite.prepare(`select count(*) as n from (${base})`).get(exclude, ...params) as { n: number }).n;
  const items = sqlite.prepare(`${base} order by date desc limit ?`).all(exclude, ...params, limit) as SenderRuleResultDto['items'];
  return { pattern, kind, total, items };
}

/**
 * Applica la regola a una conversazione (solo nell'app). Uscendo da News o Spam la conversazione entra
 * nell'analisi in background (indicizzazione, sintesi, classificazione).
 */
export function applyRule(db: Db, sqlite: Database.Database, conversationId: string, kind: SenderRuleKind) {
  const t = now();
  const before = sqlite.prepare('select is_noise as noise, is_spam as spam, archived_at as archived from conversations where id = ?').get(conversationId) as
    | { noise: number; spam: number; archived: number | null }
    | undefined;
  if (!before) return;
  const set =
    kind === 'news'
      ? 'is_noise = 1, is_spam = 0, noise_manual = 1'
      : kind === 'not_news'
        ? 'is_noise = 0, noise_manual = 1'
        : kind === 'spam'
          ? 'is_spam = 1'
          : 'is_spam = 0';
  sqlite.prepare(`update conversations set ${set}, updated_at = ? where id = ?`).run(t, conversationId);
  const leaves = (kind === 'not_news' && before.noise) || (kind === 'not_spam' && before.spam && !before.noise);
  if (leaves) {
    for (const m of sqlite.prepare('select id from messages where conversation_id = ? and deleted_at is null').all(conversationId) as { id: string }[]) {
      enqueueEmbedding(db, m.id, PRIORITY.background);
    }
    if (!before.archived) {
      enqueueSummary(db, conversationId, PRIORITY.background);
      enqueueClassification(db, conversationId, PRIORITY.background);
    }
  }
}
