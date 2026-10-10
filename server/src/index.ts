import { config } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { buildServices } from './services.ts';
import { enqueueMissingSummaries } from './ai/summarize.ts';
import { enqueueMissingEmbeddings } from './ai/embed.ts';
import { enqueueMissingTaskExtraction } from './ai/extract-tasks.ts';
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
enqueueMissingTaskExtraction(db);
enqueueMissingClassifications(db);
// Password ancora in variabili d'ambiente (env:...): si spostano nel Portachiavi.
try {
  const moved = services.accounts.migrateEnvCredentials();
  if (moved.length) app.log.info(`Password spostate nel Portachiavi per: ${moved.join(', ')}`);
} catch (err) {
  app.log.error(`Spostamento delle password nel Portachiavi non riuscito: ${(err as Error).message}`);
}
for (const account of services.accounts.list()) services.sync.start(account);
