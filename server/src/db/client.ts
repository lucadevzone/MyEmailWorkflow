import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.ts';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof openDb>['db'];

export function openDb(dbPath: string = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(config.dataDir, { recursive: true });
  const sqlite = new Database(dbPath);
  // WAL: l'interfaccia legge mentre il sync scrive.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqliteVec.load(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
