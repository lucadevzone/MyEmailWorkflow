import { config } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { buildServices } from './services.ts';
import { runRepairs } from './maintenance/repair.ts';
import { applyAiWindow } from './ai/window.ts';
import { enqueueMissingAnalysis } from './ai/missing.ts';
import { SharingService, type Writers } from './sharing/service.ts';

const { db, sqlite } = openDb();
runMigrations(db);

const services = buildServices(db, sqlite, config.blobDir);
// Processi che scrivono sul database (posta, analisi, coda attività): con la cartella condivisa (uso su più
// PC) girano solo sul PC che ha il database.
let firstStart = true;
const writers: Writers = {
  start() {
    services.runner.start();
    services.jobs.start();
    // Coda allineata alla finestra dell'analisi (solo posta recente) e lavori mancanti rimessi in coda, in
    // un'unica transazione: con migliaia di conversazioni è molto più veloce.
    const pruned = applyAiWindow(db, sqlite, () => enqueueMissingAnalysis(db));
    if (pruned) app.log.info(`Analisi: ${pruned} lavori sulla posta fuori dalla finestra tolti dalla coda`);
    if (firstStart) {
      firstStart = false;
      // Password ancora in variabili d'ambiente (env:...): si spostano nel Portachiavi.
      try {
        const moved = services.accounts.migrateEnvCredentials();
        if (moved.length) app.log.info(`Password spostate nel Portachiavi per: ${moved.join(', ')}`);
      } catch (err) {
        app.log.error(`Spostamento delle password nel Portachiavi non riuscito: ${(err as Error).message}`);
      }
      // Correzioni retroattive sulla posta già importata (una volta sola, in background).
      void runRepairs(services, (m) => app.log.info(m)).catch((err) => app.log.error(`Manutenzione non riuscita: ${(err as Error).message}`));
    }
    for (const account of services.accounts.list()) services.sync.start(account);
  },
  async stop() {
    services.runner.stop();
    services.jobs.stop();
    await services.sync.stopAll();
  },
};
const sharing = new SharingService({ sqlite, dataDir: config.dataDir, writers, log: (m) => app.log.info(m), blobs: services.blobs });
const app = buildApp({ ...services, sharing, port: config.port });

// Con Ctrl-C il segnale arriva più volte (dal terminale e da pnpm): si chiude una volta sola, lasciando
// il tempo di consegnare e liberare il database. Nota: «tsx watch» (pnpm dev) al secondo segnale uccide il
// processo senza aspettare; per l'uso di tutti i giorni c'è pnpm start.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await sharing.shutdown();
  } catch (err) {
    app.log.error(`Rilascio del database non riuscito: ${(err as Error).message}`);
    await writers.stop();
  }
  await app.close();
  sqlite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
await sharing.init();
