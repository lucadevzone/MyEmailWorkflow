import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import type { Db } from './db/client.ts';
import { registerSecurity } from './api/security.ts';
import { registerRoutes } from './api/routes.ts';

export function buildApp(deps: { db: Db; sqlite: Database.Database; port: number }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  registerSecurity(app, deps.port);
  registerRoutes(app, deps);
  return app;
}
