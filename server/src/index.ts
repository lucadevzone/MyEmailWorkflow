import { config } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';

const { db, sqlite } = openDb();
runMigrations(db);

const app = buildApp({ db, sqlite, port: config.port });

const shutdown = async () => {
  await app.close();
  sqlite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
