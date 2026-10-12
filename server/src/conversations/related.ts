// Dopo uno spostamento da Da smistare a un progetto: le altre conversazioni ancora da smistare che
// probabilmente vanno nello stesso progetto (stesso mittente, contenuto simile, già suggerite lì).
// Solo proposte: l'utente le sposta tutte insieme o una alla volta.

import type Database from 'better-sqlite3';
import type { RelatedMoveDto } from '@mmw/shared';
import { similarConversations } from '../ai/embed.ts';
import { senderOfConversation } from '../rules/sender-rules.ts';

/** Somiglianza minima (coseno, bge-m3) perché il contenuto da solo basti a proporla. */
const MIN_SIMILARITY = 0.6;
const LIMIT = 50;

export function relatedForMove(sqlite: Database.Database, conversationId: string, projectId: string): RelatedMoveDto {
  // Candidate: in Da smistare (non News, non Spam, non archiviate o cestinate).
  const inbox = sqlite
    .prepare(
      `select c.id, c.subject, c.last_message_at as date,
              (select lower(m.from_address) from messages m where m.conversation_id = c.id and m.direction = 'in' and m.deleted_at is null and m.from_address is not null order by m.date limit 1) as sender
         from conversations c
        where c.deleted_at is null and c.trashed_at is null and c.archived_at is null and c.project_id is null
          and c.is_noise = 0 and c.is_spam = 0 and c.id <> ?`,
    )
    .all(conversationId) as { id: string; subject: string | null; date: number; sender: string | null }[];
  if (!inbox.length) return { projectId, items: [] };
  const byId = new Map(inbox.map((c) => [c.id, c]));

  const sender = senderOfConversation(sqlite, conversationId);
  const similar = new Map(
    similarConversations(sqlite, conversationId, 80)
      .filter((n) => byId.has(n.conversationId) && n.similarity >= MIN_SIMILARITY)
      .map((n) => [n.conversationId, n.similarity]),
  );
  const suggested = new Set(
    (
      sqlite
        .prepare(
          `select subject_id as id from suggestions
            where kind = 'project' and status = 'pending' and json_extract(payload, '$.projectId') = ?`,
        )
        .all(projectId) as { id: string }[]
    ).map((r) => r.id),
  );

  const scored = inbox
    .map((c) => {
      const reasons: string[] = [];
      let score = 0;
      if (sender && c.sender === sender) {
        reasons.push('stesso mittente');
        score += 3;
      }
      if (suggested.has(c.id)) {
        reasons.push('suggerita per questo progetto');
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
