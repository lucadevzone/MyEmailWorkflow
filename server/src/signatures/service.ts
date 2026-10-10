// Firme: si definiscono nelle impostazioni (con un nome) e ogni progetto ne sceglie una.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { SignatureDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { projects, signatures } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';

export class SignatureError extends Error {}

export const signatureInputSchema = z.object({
  label: z.string().trim().min(1, 'Dai un nome alla firma').max(80),
  html: z.string().max(200_000),
  text: z.string().trim().min(1, 'La firma è vuota').max(20_000),
});

type Row = typeof signatures.$inferSelect;
const toDto = (r: Row): SignatureDto => ({ id: r.id, label: r.label, html: r.html, text: r.text });

export class SignatureService {
  constructor(private db: Db) {}

  list(): SignatureDto[] {
    return this.db.select().from(signatures).where(isNull(signatures.deletedAt)).orderBy(asc(signatures.label)).all().map(toDto);
  }

  get(id: string): SignatureDto | undefined {
    const r = this.db.select().from(signatures).where(and(eq(signatures.id, id), isNull(signatures.deletedAt))).get();
    return r && toDto(r);
  }

  create(raw: z.input<typeof signatureInputSchema>): SignatureDto {
    const input = signatureInputSchema.parse(raw);
    const t = now();
    const id = newId();
    this.db.insert(signatures).values({ id, ...input, createdAt: t, updatedAt: t }).run();
    return this.get(id)!;
  }

  update(id: string, raw: z.input<typeof signatureInputSchema>): SignatureDto {
    const input = signatureInputSchema.parse(raw);
    if (!this.get(id)) throw new SignatureError('Firma non trovata');
    this.db.update(signatures).set({ ...input, updatedAt: now() }).where(eq(signatures.id, id)).run();
    return this.get(id)!;
  }

  /** Eliminata: i progetti che la usavano restano senza firma. */
  remove(id: string) {
    const t = now();
    this.db.transaction((tx) => {
      tx.update(signatures).set({ deletedAt: t, updatedAt: t }).where(eq(signatures.id, id)).run();
      tx.update(projects).set({ signatureId: null, updatedAt: t }).where(eq(projects.signatureId, id)).run();
    });
  }
}
