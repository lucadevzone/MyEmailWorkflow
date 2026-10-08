import { config } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { buildServices } from './services.ts';
import { enqueueMissingSummaries } from './ai/summarize.ts';
import { enqueueMissingEmbeddings } from './ai/embed.ts';
import { enqueueMissingClassifications } from './ai/classify.ts';

const { db, sqlite } = openDb();
runMigrations(db);

const services = buildServices(db, sqlite, config.blobDir);
const app = buildApp({ ...services, port: config.port });

const shutdown = async () => {
  services.runner.stop();
  services.jobs.stop();
  await services.sync.stopAll();
  await app.close();
  sqlite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });

services.runner.start();
services.jobs.start();
enqueueMissingEmbeddings(db);
enqueueMissingSummaries(db);
enqueueMissingClassifications(db);
for (const account of services.accounts.list()) services.sync.start(account);
