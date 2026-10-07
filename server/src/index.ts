import { config } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { buildServices } from './services.ts';

const { db, sqlite } = openDb();
runMigrations(db);

const services = buildServices(db, sqlite, config.blobDir);
const app = buildApp({ ...services, port: config.port });

const shutdown = async () => {
  services.runner.stop();
  await services.sync.stopAll();
  await app.close();
  sqlite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });

services.runner.start();
for (const account of services.accounts.list()) services.sync.start(account);
