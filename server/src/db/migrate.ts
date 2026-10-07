import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.ts';
import { openDb } from './client.ts';

export function runMigrations(db: ReturnType<typeof openDb>['db']) {
  migrate(db, { migrationsFolder: config.migrationsDir });
}

// Eseguito come script: `pnpm db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { db, sqlite } = openDb();
  runMigrations(db);
  sqlite.close();
  console.log(`Migrazioni applicate: ${config.dbPath}`);
}
