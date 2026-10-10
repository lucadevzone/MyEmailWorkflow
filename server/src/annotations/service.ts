// Annotazioni (RF-G2/G3): il brano di un messaggio da cui è nata una nota o un task, salvato alla
// maniera W3C (TextQuoteSelector: testo esatto più un po' di testo prima e dopo per ritrovarlo).

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AnnotationMarkDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { annotations, notes, tasks } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';

export const quoteSchema = z.object({
  exact: z.string().min(1).max(5000),
  prefix: z.string().max(200).nullable().optional(),
  suffix: z.string().max(200).nullable().optional(),
});

export type Quote = z.infer<typeof quoteSchema>;

/** Crea l'annotazione del brano citato e ne restituisce l'id. */
export function createAnnotation(db: Db, messageId: string, quote: Quote): string {
  const t = now();
  const id = newId();
  db.insert(annotations)
    .values({ id, messageId, quoteExact: quote.exact, quotePrefix: quote.prefix ?? null, quoteSuffix: quote.suffix ?? null, createdAt: t, updatedAt: t })
    .run();
  return id;
}

/** Brani annotati di un messaggio, con la nota o il task (non eliminati) che vi sono collegati. */
export function annotationMarks(db: Db, messageId: string): AnnotationMarkDto[] {
  const anns = db.select().from(annotations).where(and(eq(annotations.messageId, messageId), isNull(annotations.deletedAt))).all();
  if (!anns.length) return [];
  const ids = anns.map((a) => a.id);
  const byId = new Map(anns.map((a) => [a.id, a]));
  const out: AnnotationMarkDto[] = [];
  for (const n of db.select().from(notes).where(and(inArray(notes.annotationId, ids), isNull(notes.deletedAt))).all()) {
    const a = byId.get(n.annotationId!)!;
    out.push({ annotationId: a.id, exact: a.quoteExact, prefix: a.quotePrefix, suffix: a.quoteSuffix, kind: 'note', itemId: n.id, label: n.body, done: false });
  }
  for (const t of db.select().from(tasks).where(and(inArray(tasks.annotationId, ids), isNull(tasks.deletedAt))).all()) {
    const a = byId.get(t.annotationId!)!;
    out.push({ annotationId: a.id, exact: a.quoteExact, prefix: a.quotePrefix, suffix: a.quoteSuffix, kind: 'task', itemId: t.id, label: t.title, done: t.status === 'done' });
  }
  return out;
}
