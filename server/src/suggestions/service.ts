import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { suggestions } from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import type { MailActions } from '../actions/mail-actions.ts';
import { conversations } from '../db/schema.ts';
import type { TaskService } from '../tasks/service.ts';
import type { TaskSuggestionPayload } from '../ai/extract-tasks.ts';

export class SuggestionError extends Error {}

type Row = typeof suggestions.$inferSelect;

export class SuggestionService {
  constructor(private db: Db, private actions: MailActions, private tasks: TaskService) {}

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
    if (r.kind === 'task') {
      // I task stanno nei progetti: da Da smistare si sceglie il progetto e la conversazione lo segue.
      const conv = this.db.select({ projectId: conversations.projectId }).from(conversations).where(eq(conversations.id, r.subjectId)).get();
      const target = conv?.projectId ?? body.projectId;
      if (!target) throw new SuggestionError('Scegli il progetto del task');
      const p = JSON.parse(r.payload) as TaskSuggestionPayload;
      this.resolve(id, 'accepted');
      if (!conv?.projectId) this.actions.move(r.subjectId, target);
      this.tasks.create({ projectId: target, title: p.title, details: p.details, dueDate: p.dueDate, conversationId: r.subjectId, messageId: p.messageId });
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
