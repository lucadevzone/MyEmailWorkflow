import Fastify from 'fastify';
import { registerSecurity } from './api/security.ts';
import { registerRoutes, type RouteDeps } from './api/routes.ts';

export function buildApp(deps: RouteDeps & { port: number }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  registerSecurity(app, deps.port);
  registerRoutes(app, deps);
  return app;
}
