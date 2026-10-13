import { config } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { buildServices } from './services.ts';
import { runRepairs } from './maintenance/repair.ts';
import { applyAiWindow } from './ai/window.ts';
import { enqueueMissingAnalysis } from './ai/missing.ts';

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
// Coda allineata alla finestra dell'analisi (solo posta recente) e lavori mancanti rimessi in coda, in
// un'unica transazione: con migliaia di conversazioni è molto più veloce.
const pruned = applyAiWindow(db, sqlite, () => enqueueMissingAnalysis(db));
if (pruned) console.log(`Analisi: ${pruned} lavori sulla posta fuori dalla finestra tolti dalla coda`);
// Password ancora in variabili d'ambiente (env:...): si spostano nel Portachiavi.
try {
  const moved = services.accounts.migrateEnvCredentials();
  if (moved.length) app.log.info(`Password spostate nel Portachiavi per: ${moved.join(', ')}`);
} catch (err) {
  app.log.error(`Spostamento delle password nel Portachiavi non riuscito: ${(err as Error).message}`);
}
for (const account of services.accounts.list()) services.sync.start(account);
// Correzioni retroattive sulla posta già importata (una volta sola, in background).
void runRepairs(services, (m) => app.log.info(m)).catch((err) => app.log.error(`Manutenzione non riuscita: ${(err as Error).message}`));
