import { config } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { BlobStore } from './store/blobs.ts';
import { SyncManager } from './sync/manager.ts';
import { AccountService } from './accounts/service.ts';
import { SettingsService } from './settings/service.ts';

const { db, sqlite } = openDb();
runMigrations(db);

const blobs = new BlobStore(db, config.blobDir);
const settings = new SettingsService(db);
const sync = new SyncManager({ db, sqlite, blobs }, () => settings.get().initialSyncDays);

const app = buildApp({ db, sqlite, blobs, sync, port: config.port });

const shutdown = async () => {
  await sync.stopAll();
  await app.close();
  sqlite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });

for (const account of new AccountService(db).list()) sync.start(account);
