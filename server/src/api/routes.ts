import type { FastifyInstance } from 'fastify';
import type { HealthDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import type Database from 'better-sqlite3';
import { config } from '../config.ts';
import { AccountService, createAccountSchema } from '../accounts/service.ts';
import { SettingsService, settingsPatchSchema } from '../settings/service.ts';
import { hasModel, ollamaStatus } from '../ai/ollama.ts';

export function registerRoutes(app: FastifyInstance, deps: { db: Db; sqlite: Database.Database }) {
  const accountsSvc = new AccountService(deps.db);
  const settingsSvc = new SettingsService(deps.db);

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
    return reply.code(201).send(accountsSvc.create(parsed.data));
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    return accountsSvc.remove(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Account non trovato' });
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/test', async (req) => accountsSvc.testConnection(req.params.id));

  app.get('/api/settings', async () => settingsSvc.get());

  app.put('/api/settings', async (req, reply) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    return settingsSvc.update(parsed.data);
  });
}
