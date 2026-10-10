import type { FastifyInstance } from 'fastify';
import type { HealthDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import type Database from 'better-sqlite3';
import { config } from '../config.ts';
import { AccountService, createAccountSchema } from '../accounts/service.ts';
import { SettingsService, settingsPatchSchema } from '../settings/service.ts';
import { hasModel, ollamaStatus } from '../ai/ollama.ts';
import { ConversationService } from '../conversations/service.ts';
import { htmlCsp, prepareHtml } from '../conversations/html.ts';
import { attachments, messages } from '../db/schema.ts';
import { and, eq, isNull } from 'drizzle-orm';
import type { BlobStore } from '../store/blobs.ts';
import type { SyncManager } from '../sync/manager.ts';
import { bus } from '../events/bus.ts';
import { ProjectError, ProjectService, projectInputSchema, projectPatchSchema } from '../projects/service.ts';
import { ActivityError, type ActivityService } from '../activities/service.ts';
import type { ActivityRunner } from '../activities/runner.ts';
import { ActionError, composeSchema, type MailActions } from '../actions/mail-actions.ts';
import type { ActivityQueueDto, ConversationView } from '@mmw/shared';
import { ZodError, type ZodType } from 'zod';
import { Readable } from 'node:stream';
import { annotationMarks } from '../annotations/service.ts';
import type { SearchScope } from '@mmw/shared';
import type { SearchService } from '../search/service.ts';
import { chatInputSchema, threadOf, type AssistantService } from '../ai/assistant.ts';
import { draftCreateSchema, draftPatchSchema, type DraftService } from '../drafts/service.ts';

import { PeopleError, contactInputSchema, groupInputSchema, type PeopleService } from '../people/service.ts';
import { NotesError, noteInputSchema, type NotesService } from '../notes/service.ts';
import type { PeopleScope } from '../people/service.ts';
import { SuggestionError, type SuggestionService } from '../suggestions/service.ts';
import { enqueueClassification, reclassifyInbox } from '../ai/classify.ts';
import { PRIORITY } from '../jobs/queue.ts';
import { TaskError, taskInputSchema, taskMoveSchema, taskPatchSchema, type TaskService } from '../tasks/service.ts';

export interface RouteDeps {
  db: Db;
  sqlite: Database.Database;
  blobs: BlobStore;
  sync: SyncManager;
  activities: ActivityService;
  runner: ActivityRunner;
  actions: MailActions;
  people: PeopleService;
  notes: NotesService;
  suggestions: SuggestionService;
  tasks: TaskService;
  drafts: DraftService;
  assistant: AssistantService;
  search: SearchService;
}

function parse<T>(schema: ZodType<T>, body: unknown): T {
  return schema.parse(body);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const accountsSvc = new AccountService(deps.db);
  const settingsSvc = new SettingsService(deps.db);
  const conversationsSvc = new ConversationService(deps.db);
  const projectsSvc = new ProjectService(deps.db);

  // Errori di validazione e di dominio → 400 con messaggio leggibile.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join('; ') });
    if (
      err instanceof ProjectError ||
      err instanceof ActivityError ||
      err instanceof ActionError ||
      err instanceof PeopleError ||
      err instanceof NotesError ||
      err instanceof SuggestionError ||
      err instanceof TaskError
    ) {
      return reply.code(400).send({ error: err.message });
    }
    app.log.error(err);
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message });
  });

  app.get('/api/health', async (): Promise<HealthDto> => {
    let vec: string | null = null;
    let dbOk = false;
    try {
      vec = (deps.sqlite.prepare('select vec_version() as v').get() as { v: string }).v;
      dbOk = true;
    } catch {}
    const ollama = await ollamaStatus();
    const llmAvailable = hasModel(ollama.models, config.ollama.llmModel);
    const embedAvailable = hasModel(ollama.models, config.ollama.embedModel);
    return {
      ok: dbOk && ollama.ok && llmAvailable && embedAvailable,
      db: { ok: dbOk, vec },
      ollama,
      config: {
        llmModel: config.ollama.llmModel,
        defaultLlmModel: config.defaultLlmModel,
        embedModel: config.ollama.embedModel,
        llmAvailable,
        embedAvailable,
      },
    };
  });

  app.get('/api/accounts', async () => accountsSvc.list());

  app.post('/api/accounts', async (req, reply) => {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    const account = accountsSvc.create(parsed.data);
    deps.sync.start(account);
    return reply.code(201).send(account);
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    await deps.sync.stop(req.params.id);
    return accountsSvc.remove(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Account non trovato' });
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/test', async (req) => accountsSvc.testConnection(req.params.id));

  app.get('/api/settings', async () => settingsSvc.get());

  app.put('/api/settings', async (req, reply) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    const updated = settingsSvc.update(parsed.data);
    if (parsed.data.activityBatchMinutes !== undefined) deps.runner.schedule();
    return updated;
  });

  // ─── Sync ──────────────────────────────────────────────────────────────────

  app.get('/api/sync/status', async () => deps.sync.statuses());

  // ─── Conversazioni ─────────────────────────────────────────────────────────

  app.get<{
    Querystring: { view?: string; projectId?: string; person?: string; archived?: string; before?: string; limit?: string };
  }>(
    '/api/conversations',
    async (req, reply) => {
      const view = (req.query.view ?? 'inbox') as ConversationView;
      if (!['inbox', 'noise', 'project', 'person'].includes(view)) return reply.code(400).send({ error: 'view non valida' });
      return conversationsSvc.list({
        view,
        projectId: req.query.projectId,
        person: req.query.person,
        personAddressIds: req.query.person ? deps.people.addressIdsFor(req.query.person) : undefined,
        archived: req.query.archived === '1',
        before: req.query.before ? Number(req.query.before) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
    },
  );

  app.get('/api/conversations/counts', async () => conversationsSvc.counts());

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    return conversationsSvc.get(req.params.id) ?? reply.code(404).send({ error: 'Conversazione non trovata' });
  });

  app.post<{ Params: { id: string }; Body: { isNoise?: unknown } }>('/api/conversations/:id/noise', async (req, reply) => {
    if (typeof req.body?.isNoise !== 'boolean') return reply.code(400).send({ error: 'isNoise deve essere booleano' });
    if (!conversationsSvc.setNoise(req.params.id, req.body.isNoise)) return reply.code(404).send({ error: 'Conversazione non trovata' });
    enqueueClassification(deps.db, req.params.id, PRIORITY.normal); // rumore → niente suggerimenti; non rumore → si classifica
    bus.publish({ type: 'conversations', ids: [req.params.id] });
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { images?: string } }>('/api/messages/:id/html', async (req, reply) => {
    const msg = deps.db
      .select({ htmlBlobSha: messages.htmlBlobSha })
      .from(messages)
      .where(and(eq(messages.id, req.params.id), isNull(messages.deletedAt)))
      .get();
    if (!msg?.htmlBlobSha) return reply.code(404).send({ error: 'HTML non disponibile' });
    const cids = deps.db
      .select({ id: attachments.id, contentId: attachments.contentId })
      .from(attachments)
      .where(eq(attachments.messageId, req.params.id))
      .all();
    const cidMap = new Map(
      cids.filter((c) => c.contentId).map((c) => [c.contentId!.replace(/^<|>$/g, ''), `/api/attachments/${c.id}?inline=1`]),
    );
    const html = prepareHtml(deps.blobs.read(msg.htmlBlobSha).toString('utf8'), cidMap);
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', htmlCsp(req.query.images === '1'))
      .header('x-content-type-options', 'nosniff')
      .send(html);
  });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/api/attachments/:id', async (req, reply) => {
    const att = deps.db.select().from(attachments).where(eq(attachments.id, req.params.id)).get();
    if (!att) return reply.code(404).send({ error: 'Allegato non trovato' });
    const filename = (att.filename ?? 'allegato').replace(/["\\\r\n]/g, '_');
    // Inline solo per immagini (cid:); tutto il resto come download, per non eseguire contenuti attivi.
    const inline = req.query.inline === '1' && (att.mime ?? '').startsWith('image/') && att.mime !== 'image/svg+xml';
    return reply
      .header('content-type', inline ? att.mime! : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('x-content-type-options', 'nosniff')
      .send(deps.blobs.read(att.blobSha));
  });

  // ─── Eventi (SSE) ──────────────────────────────────────────────────────────

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    for (const status of deps.sync.statuses()) send({ type: 'sync', status });
    const unsubscribe = bus.subscribe(send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ─── Azioni sulle conversazioni ────────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/api/conversations/:id/read', async (req) => ({ activityIds: deps.actions.markRead(req.params.id) }));
  app.post<{ Params: { id: string }; Body: { important?: boolean } }>('/api/messages/:id/important', async (req) => ({
    activityIds: deps.actions.setImportant(req.params.id, req.body?.important !== false),
  }));
  app.post<{ Params: { id: string } }>('/api/messages/:id/read', async (req) => ({ activityIds: deps.actions.markMessageRead(req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/conversations/:id/unread', async (req) => ({ activityIds: deps.actions.markUnread(req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/conversations/:id/archive', async (req) => ({ activityIds: deps.actions.archive(req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/conversations/:id/unarchive', async (req) => {
    deps.actions.unarchive(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/trash', async (req) => ({ activityIds: deps.actions.trash(req.params.id) }));
  app.post<{ Params: { id: string }; Body: { projectId?: string | null } }>('/api/conversations/:id/move', async (req) => {
    const projectId = req.body?.projectId ?? null;
    return deps.actions.move(req.params.id, projectId);
  });

  app.post<{ Body: { view?: string; projectId?: string } }>('/api/views/read', async (req, reply) => {
    const v = req.body?.view;
    if (v === 'project' && req.body?.projectId) return deps.actions.markViewRead({ view: 'project', projectId: req.body.projectId });
    if (v === 'inbox' || v === 'noise') return deps.actions.markViewRead({ view: v });
    return reply.code(400).send({ error: 'Vista non valida' });
  });

  app.post<{ Params: { id: string } }>('/api/attachments/:id/to-resource', async (req, reply) => {
    const att = deps.db.select().from(attachments).where(eq(attachments.id, req.params.id)).get();
    if (!att) return reply.code(404).send({ error: 'Allegato non trovato' });
    const msg = deps.db.select({ c: messages.conversationId }).from(messages).where(eq(messages.id, att.messageId)).get()!;
    const resource = deps.notes.addFromBlob(msg.c, att.filename ?? 'allegato', att.blobSha);
    bus.publish({ type: 'conversations', ids: [msg.c] });
    return reply.code(201).send(resource);
  });

  app.post('/api/compose', async (req, reply) => reply.code(201).send(deps.actions.compose(parse(composeSchema, req.body))));

  // ─── Progetti ──────────────────────────────────────────────────────────────

  app.get('/api/projects', async () => projectsSvc.list());

  app.post('/api/projects', async (req, reply) => {
    const project = projectsSvc.create(parse(projectInputSchema, req.body));
    reclassifyInbox(deps.db); // un progetto nuovo può accogliere posta già in Da smistare
    bus.publish({ type: 'projects' });
    return reply.code(201).send(project);
  });

  app.put<{ Body: { ids?: unknown } }>('/api/projects/order', async (req, reply) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return reply.code(400).send({ error: 'ids deve essere un elenco' });
    projectsSvc.reorder(ids as string[]);
    bus.publish({ type: 'projects' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/remove', async (req) => {
    const res = projectsSvc.remove(req.params.id);
    reclassifyInbox(deps.db);
    bus.publish({ type: 'projects' });
    bus.publish({ type: 'conversations', ids: [] });
    return res;
  });

  app.put<{ Params: { id: string }; Body: { keys?: unknown } }>('/api/projects/:id/members/order', async (req, reply) => {
    const keys = req.body?.keys;
    if (!Array.isArray(keys) || !keys.every((x) => typeof x === 'string')) return reply.code(400).send({ error: 'keys deve essere un elenco' });
    deps.people.reorderProjectMembers(req.params.id, keys as string[]);
    bus.publish({ type: 'people' });
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const patch = parse(projectPatchSchema, req.body);
    const project = projectsSvc.update(req.params.id, patch);
    if (!project) return reply.code(404).send({ error: 'Progetto non trovato' });
    if (patch.name !== undefined || patch.description !== undefined || patch.archived !== undefined) reclassifyInbox(deps.db);
    bus.publish({ type: 'projects' });
    return project;
  });

  // ─── Coda attività ─────────────────────────────────────────────────────────

  app.get('/api/activities', async (): Promise<ActivityQueueDto> => ({
    activities: deps.activities.list(),
    nextRunAt: deps.runner.nextRunAt,
  }));

  app.post<{ Params: { id: string } }>('/api/activities/:id/cancel', async (req) => deps.activities.cancel(req.params.id));

  app.post<{ Params: { id: string } }>('/api/activities/:id/run', async (req) => {
    deps.activities.markUrgent(req.params.id);
    void deps.runner.run([req.params.id]);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/activities/:id/retry', async (req) => {
    deps.activities.retry(req.params.id);
    return { ok: true };
  });

  app.post('/api/activities/run', async () => {
    void deps.runner.run();
    return { ok: true };
  });

  // Caricamenti binari (file, foto): corpo grezzo; i limiti per tipo li applicano i servizi.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  // ─── Persone ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { view?: string; projectId?: string } }>('/api/people', async (req, reply) => {
    const v = req.query.view ?? 'all';
    let scope: PeopleScope;
    if (v === 'project') {
      if (!req.query.projectId) return reply.code(400).send({ error: 'projectId mancante' });
      scope = { view: 'project', projectId: req.query.projectId };
    } else if (v === 'inbox' || v === 'noise' || v === 'all') scope = { view: v };
    else return reply.code(400).send({ error: 'view non valida' });
    return deps.people.inScope(scope);
  });

  app.get('/api/people/directory', async () => deps.people.directory());

  app.get<{ Querystring: { emails?: string } }>('/api/people/suggest-project', async (req) =>
    deps.people.suggestProjects((req.query.emails ?? '').split(',')),
  );

  app.post('/api/contacts', async (req, reply) => {
    const person = deps.people.createContact(parse(contactInputSchema, req.body));
    bus.publish({ type: 'people' });
    return reply.code(201).send(person);
  });

  app.patch<{ Params: { id: string } }>('/api/contacts/:id', async (req) => {
    const person = deps.people.updateContact(req.params.id, parse(contactInputSchema.partial(), req.body));
    bus.publish({ type: 'people' });
    return person;
  });

  app.delete<{ Params: { id: string } }>('/api/contacts/:id', async (req, reply) => {
    deps.people.deleteContact(req.params.id);
    bus.publish({ type: 'people' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { personKey?: string } }>('/api/contacts/:id/merge', async (req, reply) => {
    if (!req.body?.personKey) return reply.code(400).send({ error: 'personKey mancante' });
    const person = deps.people.merge(req.params.id, req.body.personKey);
    bus.publish({ type: 'people' });
    return person;
  });

  // Foto: corpo binario (application/octet-stream), già ridimensionata dal client.
  app.put<{ Params: { id: string } }>('/api/contacts/:id/avatar', async (req) => {
    const person = deps.people.setAvatar(req.params.id, req.body as Buffer);
    bus.publish({ type: 'people' });
    return person;
  });

  app.delete<{ Params: { id: string } }>('/api/contacts/:id/avatar', async (req) => {
    const person = deps.people.setAvatar(req.params.id, null);
    bus.publish({ type: 'people' });
    return person;
  });

  app.get<{ Params: { id: string } }>('/api/contacts/:id/avatar', async (req, reply) => {
    const img = deps.people.avatar(req.params.id);
    if (!img) return reply.code(404).send({ error: 'Nessuna foto' });
    return reply
      .header('content-type', img.mime)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(img.data);
  });

  app.post<{ Params: { id: string }; Body: { contactId?: string; name?: string; email?: string } }>(
    '/api/projects/:id/contacts',
    async (req, reply) => {
      const person = deps.people.addToProject(req.params.id, req.body ?? {});
      bus.publish({ type: 'people' });
      return reply.code(201).send(person);
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/members', async (req) => deps.people.projectMembers(req.params.id));

  app.post<{ Params: { id: string }; Body: { groupId?: string } }>('/api/projects/:id/groups', async (req, reply) => {
    if (!req.body?.groupId) return reply.code(400).send({ error: 'groupId mancante' });
    deps.people.addGroupToProject(req.params.id, req.body.groupId);
    bus.publish({ type: 'people' });
    return reply.code(201).send(deps.people.projectMembers(req.params.id));
  });

  app.delete<{ Params: { id: string; groupId: string } }>('/api/projects/:id/groups/:groupId', async (req, reply) => {
    deps.people.removeGroupFromProject(req.params.id, req.params.groupId);
    bus.publish({ type: 'people' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { groupName?: string } }>('/api/conversations/:id/participants-to-project', async (req) => {
    const members = deps.people.participantsToProject(req.params.id, req.body?.groupName);
    bus.publish({ type: 'people' });
    return members;
  });

  app.delete<{ Params: { id: string; contactId: string } }>('/api/projects/:id/contacts/:contactId', async (req, reply) => {
    deps.people.removeFromProject(req.params.id, req.params.contactId);
    bus.publish({ type: 'people' });
    return reply.code(204).send();
  });

  app.post('/api/groups', async (req, reply) => {
    const id = deps.people.saveGroup(null, parse(groupInputSchema, req.body));
    bus.publish({ type: 'people' });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>('/api/groups/:id', async (req) => {
    deps.people.saveGroup(req.params.id, parse(groupInputSchema, req.body));
    bus.publish({ type: 'people' });
    return { id: req.params.id };
  });

  app.delete<{ Params: { id: string } }>('/api/groups/:id', async (req, reply) => {
    deps.people.deleteGroup(req.params.id);
    bus.publish({ type: 'people' });
    return reply.code(204).send();
  });

  // ─── Note e risorse ────────────────────────────────────────────────────────

  const touched = (conversationId: string | null) => {
    if (conversationId) bus.publish({ type: 'conversations', ids: [conversationId] });
  };

  app.get<{ Params: { id: string } }>('/api/messages/:id/annotations', async (req) => annotationMarks(deps.db, req.params.id));

  app.post('/api/notes', async (req, reply) => {
    const note = deps.notes.createNote(parse(noteInputSchema, req.body));
    touched(note.conversationId);
    return reply.code(201).send(note);
  });

  app.patch<{ Params: { id: string }; Body: { body?: string } }>('/api/notes/:id', async (req) => {
    const note = deps.notes.updateNote(req.params.id, req.body?.body ?? '');
    touched(note.conversationId);
    return note;
  });

  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
    touched(deps.notes.deleteNote(req.params.id));
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Querystring: { filename?: string } }>('/api/conversations/:id/resources', async (req, reply) => {
    const filename = (req.query.filename ?? 'file').slice(0, 255);
    const mime = (req.headers['x-file-type'] as string | undefined) || null;
    const resource = deps.notes.addFile({ conversationId: req.params.id }, filename, req.body as Buffer, mime);
    touched(req.params.id);
    return reply.code(201).send(resource);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/resources', async (req) => deps.notes.resourcesForProject(req.params.id));

  app.get<{ Params: { id: string } }>('/api/resources/:id', async (req, reply) => {
    const r = deps.notes.getResource(req.params.id);
    if (!r?.blobSha) return reply.code(404).send({ error: 'Risorsa non trovata' });
    const filename = r.title.replace(/["\\\r\n]/g, '_');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('x-content-type-options', 'nosniff')
      .send(deps.blobs.read(r.blobSha));
  });

  app.delete<{ Params: { id: string } }>('/api/resources/:id', async (req, reply) => {
    touched(deps.notes.deleteResource(req.params.id));
    return reply.code(204).send();
  });

  // ─── Bozze ─────────────────────────────────────────────────────────────────

  app.post('/api/drafts', async (req, reply) => {
    const d = deps.drafts.create(parse(draftCreateSchema, req.body));
    touched(d.conversationId);
    return reply.code(201).send(d);
  });
  app.get<{ Params: { id: string } }>('/api/drafts/:id', async (req) => deps.drafts.get(req.params.id));
  app.get<{ Params: { id: string } }>('/api/conversations/:id/drafts', async (req) => deps.drafts.byConversation(req.params.id));
  app.put<{ Params: { id: string } }>('/api/drafts/:id', async (req) => deps.drafts.update(req.params.id, parse(draftPatchSchema, req.body)));
  app.delete<{ Params: { id: string } }>('/api/drafts/:id', async (req, reply) => {
    touched(deps.drafts.remove(req.params.id));
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Querystring: { filename?: string } }>('/api/drafts/:id/attachments', async (req) => {
    const filename = (req.query.filename ?? 'file').slice(0, 255);
    const mime = (req.headers['x-file-type'] as string | undefined) || null;
    return deps.drafts.addFile(req.params.id, filename, req.body as Buffer, mime);
  });
  app.post<{ Params: { id: string }; Body: { resourceId?: string } }>('/api/drafts/:id/resources', async (req) =>
    deps.drafts.addResource(req.params.id, String(req.body?.resourceId ?? '')),
  );
  app.delete<{ Params: { id: string; attId: string } }>('/api/drafts/:id/attachments/:attId', async (req) =>
    deps.drafts.removeAttachment(req.params.id, req.params.attId),
  );
  app.post<{ Params: { id: string }; Body: { urgent?: boolean } }>('/api/drafts/:id/send', async (req, reply) => {
    const res = deps.drafts.send(req.params.id, req.body?.urgent === true);
    touched(res.previousConversationId);
    return reply.code(201).send(res);
  });

  // ─── Ricerca ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { q?: string; scope?: string } }>('/api/search', async (req) => {
    const q = String(req.query.q ?? '').slice(0, 300);
    const raw = String(req.query.scope ?? 'all');
    const scope: SearchScope = raw === 'inbox' || raw === 'news' || /^project:[\w-]+$/.test(raw) ? (raw as SearchScope) : 'all';
    return deps.search.search(q, scope);
  });

  // ─── Assistente ────────────────────────────────────────────────────────────

  const threadParam = (q: { conversationId?: string; draftId?: string }) => {
    const t = threadOf(q);
    if (!t) throw new ActionError('Serve una conversazione o una bozza salvata');
    return t;
  };
  app.get<{ Querystring: { conversationId?: string; draftId?: string } }>('/api/assistant/thread', async (req) => {
    const t = threadOf(req.query);
    return t ? deps.assistant.thread(t) : [];
  });
  app.delete<{ Querystring: { conversationId?: string; draftId?: string } }>('/api/assistant/thread', async (req, reply) => {
    deps.assistant.clear(threadParam(req.query));
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/reply-ideas', async (req) => deps.assistant.replyIdeas(req.params.id));

  // Risposta in streaming (testo semplice, a pezzi). Un errore a metà arriva come riga "[errore] …".
  app.post('/api/assistant/chat', async (req, reply) => {
    const input = parse(chatInputSchema, req.body);
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    const gen = deps.assistant.chat(input, abort.signal);
    // Il primo pezzo si attende qui: così gli errori iniziali (Ollama spento, niente da ritoccare) diventano un 400/502.
    let first: IteratorResult<string>;
    try {
      first = await gen.next();
    } catch (err) {
      if (err instanceof ActionError || (err instanceof Error && err.message.startsWith('Non c'))) return reply.code(400).send({ error: err.message });
      return reply.code(502).send({ error: `Assistente non disponibile: ${(err as Error).message}` });
    }
    async function* body() {
      if (!first.done) yield first.value;
      try {
        for await (const piece of { [Symbol.asyncIterator]: () => gen }) yield piece;
      } catch (err) {
        if (!abort.signal.aborted) yield `\n[errore] ${(err as Error).message}`;
      }
    }
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(Readable.from(body()));
  });

  // Domanda su più conversazioni (dalla ricerca), in streaming.
  app.post<{ Body: { question?: string; sources?: { conversationId?: string; messageId?: string }[] } }>('/api/assistant/ask', async (req, reply) => {
    const question = String(req.body?.question ?? '').trim().slice(0, 1000);
    const ids = (Array.isArray(req.body?.sources) ? req.body!.sources! : [])
      .filter((x) => typeof x?.conversationId === 'string')
      .map((x) => ({ conversationId: x.conversationId!, messageId: typeof x.messageId === 'string' ? x.messageId : null }))
      .slice(0, 6);
    if (!question) throw new ActionError('Scrivi una domanda');
    // Senza fonti dalla ricerca (es. una domanda lunga che non trova tutte le parole) si cerca in modo più largo.
    let sources = ids;
    let found: { conversationId: string; projectId: string | null; isNoise: boolean; title: string }[] = [];
    if (!sources.length) {
      const res = await deps.search.search(question, 'all', { loose: true });
      found = res.conversations.slice(0, 6).map((c) => ({ conversationId: c.conversationId, projectId: c.projectId, isNoise: c.isNoise, title: c.title }));
      sources = res.conversations.slice(0, 6).map((c) => ({ conversationId: c.conversationId, messageId: c.messageId }));
    }
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    const gen = deps.assistant.ask(question, sources, abort.signal);
    let first: IteratorResult<string>;
    try {
      first = await gen.next();
    } catch (err) {
      return reply.code(502).send({ error: `Assistente non disponibile: ${(err as Error).message}` });
    }
    async function* body() {
      if (!first.done) yield first.value;
      try {
        for await (const piece of { [Symbol.asyncIterator]: () => gen }) yield piece;
      } catch (err) {
        if (!abort.signal.aborted) yield `\n[errore] ${(err as Error).message}`;
      }
    }
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-mmw-sources', encodeURIComponent(JSON.stringify(found)))
      .send(Readable.from(body()));
  });

  app.put<{ Params: { id: string }; Body: { summary?: string } }>('/api/conversations/:id/summary', async (req) => {
    const text = String(req.body?.summary ?? '').trim();
    if (!text) throw new ActionError('La sintesi è vuota');
    conversationsSvc.setSummary(req.params.id, text);
    bus.publish({ type: 'conversations', ids: [req.params.id] });
    return { ok: true };
  });

  // ─── Suggerimenti ──────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { projectId?: string } }>('/api/suggestions/:id/accept', async (req) => {
    const r = deps.suggestions.accept(req.params.id, req.body ?? {});
    bus.publish({ type: 'conversations', ids: [r.conversationId] });
    bus.publish({ type: 'tasks' });
    return r;
  });

  app.post<{ Params: { id: string } }>('/api/suggestions/:id/reject', async (req) => {
    const r = deps.suggestions.reject(req.params.id);
    bus.publish({ type: 'conversations', ids: [r.conversationId] });
    return r;
  });

  // ─── Task ──────────────────────────────────────────────────────────────────

  const tasksChanged = (conversationId: string | null | undefined) => {
    bus.publish({ type: 'tasks' });
    if (conversationId) bus.publish({ type: 'conversations', ids: [conversationId] });
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/tasks', async (req) => deps.tasks.forProject(req.params.id));
  app.get<{ Params: { id: string } }>('/api/conversations/:id/tasks', async (req) => deps.tasks.forConversation(req.params.id));

  app.post('/api/tasks', async (req, reply) => {
    const task = deps.tasks.create(parse(taskInputSchema, req.body));
    tasksChanged(task.conversationId);
    return reply.code(201).send(task);
  });

  app.post<{ Params: { id: string }; Body: { messageId?: string | null } }>('/api/conversations/:id/remind-reply', async (req, reply) => {
    const task = deps.tasks.remindReply(req.params.id, req.body?.messageId ?? null);
    tasksChanged(task.conversationId);
    return reply.code(201).send(task);
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const task = deps.tasks.update(req.params.id, parse(taskPatchSchema, req.body));
    tasksChanged(task.conversationId);
    return task;
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/move', async (req) => {
    const task = deps.tasks.move(req.params.id, parse(taskMoveSchema, req.body).afterId);
    tasksChanged(null);
    return task;
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = deps.tasks.get(req.params.id);
    deps.tasks.remove(req.params.id);
    tasksChanged(task?.conversationId);
    return reply.code(204).send();
  });
}
