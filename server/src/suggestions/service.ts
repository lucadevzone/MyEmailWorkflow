import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { suggestions } from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import type { MailActions } from '../actions/mail-actions.ts';

export class SuggestionError extends Error {}

type Row = typeof suggestions.$inferSelect;

export class SuggestionService {
  constructor(private db: Db, private actions: MailActions) {}

  private get(id: string): Row {
    const r = this.db.select().from(suggestions).where(eq(suggestions.id, id)).get();
    if (!r) throw new SuggestionError('Suggerimento non trovato');
    if (r.status !== 'pending') throw new SuggestionError('Suggerimento già gestito');
    return r;
  }

  /** Applica il suggerimento. Per "nuovo progetto" il client crea il progetto e ne passa l'id. */
  accept(id: string, body: { projectId?: string } = {}): { conversationId: string } {
    const r = this.get(id);
    const payload = JSON.parse(r.payload) as { projectId: string | null };
    const projectId = r.kind === 'new_project' ? body.projectId : payload.projectId;
    if ((r.kind === 'project' || r.kind === 'new_project') && r.subjectType === 'conversation') {
      if (!projectId) throw new SuggestionError('Serve il progetto in cui spostare la conversazione');
      // move() cancella i suggerimenti di progetto in attesa: si marca prima come accettato.
      this.resolve(id, 'accepted');
      this.actions.move(r.subjectId, projectId);
      return { conversationId: r.subjectId };
    }
    throw new SuggestionError('Tipo di suggerimento non ancora gestito');
  }

  reject(id: string): { conversationId: string } {
    const r = this.get(id);
    this.resolve(id, 'rejected');
    return { conversationId: r.subjectId };
  }

  private resolve(id: string, status: 'accepted' | 'rejected') {
    this.db.update(suggestions).set({ status, resolvedAt: now() }).where(eq(suggestions.id, id)).run();
  }
}
