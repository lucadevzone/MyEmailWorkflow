// Dopo uno spostamento in un progetto, o un'archiviazione: le altre conversazioni che probabilmente
// vanno trattate allo stesso modo (stesso mittente, contenuto simile, già suggerite dall'analizzatore).
// Solo proposte: l'utente agisce su tutte insieme o una alla volta.

import type Database from 'better-sqlite3';
import type { RelatedMoveDto } from '@mmw/shared';
import { similarConversations } from '../ai/embed.ts';
import { senderOfConversation } from '../rules/sender-rules.ts';

/** Somiglianza minima (coseno, bge-m3) perché il contenuto da solo basti a proporla. */
const MIN_SIMILARITY = 0.6;
const LIMIT = 50;

type Target = { mode: 'move'; projectId: string } | { mode: 'archive' };

interface Candidate {
  id: string;
  subject: string | null;
  date: number;
  sender: string | null;
}

const SENDER = `(select lower(m.from_address) from messages m where m.conversation_id = c.id and m.direction = 'in' and m.deleted_at is null and m.from_address is not null order by m.date limit 1) as sender`;

/** Candidate: spostamento → ancora in Da smistare; archiviazione → nello stesso posto della conversazione archiviata. */
function candidates(sqlite: Database.Database, conversationId: string, target: Target): Candidate[] {
  const base = `select c.id, c.subject, c.last_message_at as date, ${SENDER} from conversations c
                 where c.deleted_at is null and c.trashed_at is null and c.archived_at is null and c.is_spam = 0 and c.id <> ?`;
  if (target.mode === 'move') return sqlite.prepare(`${base} and c.project_id is null and c.is_noise = 0`).all(conversationId) as Candidate[];
  const src = sqlite.prepare('select project_id as projectId, is_noise as noise from conversations where id = ?').get(conversationId) as
    | { projectId: string | null; noise: number }
    | undefined;
  if (!src) return [];
  if (src.projectId) return sqlite.prepare(`${base} and c.project_id = ?`).all(conversationId, src.projectId) as Candidate[];
  return sqlite.prepare(`${base} and c.project_id is null and c.is_noise = ?`).all(conversationId, src.noise) as Candidate[];
}

/** Conversazioni con un suggerimento in attesa coerente con l'azione fatta. */
function suggested(sqlite: Database.Database, target: Target): Set<string> {
  const rows =
    target.mode === 'move'
      ? sqlite.prepare(`select subject_id as id from suggestions where kind = 'project' and status = 'pending' and json_extract(payload, '$.projectId') = ?`).all(target.projectId)
      : sqlite.prepare(`select subject_id as id from suggestions where kind = 'action' and status = 'pending' and json_extract(payload, '$.action') = 'archive'`).all();
  return new Set((rows as { id: string }[]).map((r) => r.id));
}

export function relatedFor(sqlite: Database.Database, conversationId: string, target: Target): RelatedMoveDto {
  const projectId = target.mode === 'move' ? target.projectId : null;
  const pool = candidates(sqlite, conversationId, target);
  if (!pool.length) return { projectId, items: [] };
  const inPool = new Set(pool.map((c) => c.id));
  const sender = senderOfConversation(sqlite, conversationId);
  const similar = new Map(
    similarConversations(sqlite, conversationId, 80)
      .filter((n) => inPool.has(n.conversationId) && n.similarity >= MIN_SIMILARITY)
      .map((n) => [n.conversationId, n.similarity]),
  );
  const hinted = suggested(sqlite, target);
  const hint = target.mode === 'move' ? 'suggerita per questo progetto' : 'archiviazione suggerita';

  const scored = pool
    .map((c) => {
      const reasons: string[] = [];
      let score = 0;
      if (sender && c.sender === sender) {
        reasons.push('stesso mittente');
        score += 3;
      }
      if (hinted.has(c.id)) {
        reasons.push(hint);
        score += 2;
      }
      const sim = similar.get(c.id);
      if (sim !== undefined) {
        reasons.push('contenuto simile');
        score += sim;
      }
      return { c, reasons, score };
    })
    .filter((x) => x.reasons.length > 0)
    .sort((a, b) => b.score - a.score || b.c.date - a.c.date)
    .slice(0, LIMIT);

  return {
    projectId,
    items: scored.map(({ c, reasons }) => ({ conversationId: c.id, subject: c.subject, from: c.sender, date: c.date, reasons })),
  };
}

/** Compatibilità: spostamento in un progetto. */
export const relatedForMove = (sqlite: Database.Database, conversationId: string, projectId: string) => relatedFor(sqlite, conversationId, { mode: 'move', projectId });
