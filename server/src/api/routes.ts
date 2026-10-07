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

export interface RouteDeps {
  db: Db;
  sqlite: Database.Database;
  blobs: BlobStore;
  sync: SyncManager;
  activities: ActivityService;
  runner: ActivityRunner;
  actions: MailActions;
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
    if (err instanceof ProjectError || err instanceof ActivityError || err instanceof ActionError) {
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

  app.get<{ Querystring: { view?: string; projectId?: string; archived?: string; before?: string; limit?: string } }>(
    '/api/conversations',
    async (req, reply) => {
      const view = (req.query.view ?? 'inbox') as ConversationView;
      if (!['inbox', 'noise', 'project'].includes(view)) return reply.code(400).send({ error: 'view non valida' });
      return conversationsSvc.list({
        view,
        projectId: req.query.projectId,
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

  app.post('/api/compose', async (req, reply) => reply.code(201).send(deps.actions.compose(parse(composeSchema, req.body))));

  // ─── Progetti ──────────────────────────────────────────────────────────────

  app.get('/api/projects', async () => projectsSvc.list());

  app.post('/api/projects', async (req, reply) => {
    const project = projectsSvc.create(parse(projectInputSchema, req.body));
    bus.publish({ type: 'projects' });
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const project = projectsSvc.update(req.params.id, parse(projectPatchSchema, req.body));
    if (!project) return reply.code(404).send({ error: 'Progetto non trovato' });
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
}
