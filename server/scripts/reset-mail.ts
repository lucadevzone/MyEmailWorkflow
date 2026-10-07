// Sviluppo: cancella posta, conversazioni e stato di sync mantenendo account e impostazioni.
// Al riavvio del server la posta viene reimportata da zero. I blob su disco restano (deduplicati).
// Uso: pnpm db:reset-mail  (con il server fermo)
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

const { db, sqlite } = openDb();
runMigrations(db);
const tables = [
  'message_fts', 'chunk_vec', 'chunks', 'suggestions', 'tasks', 'notes', 'annotations', 'resources',
  'attachments', 'version_chains', 'message_addresses', 'messages', 'conversations', 'contact_addresses', 'sync_state',
];
sqlite.transaction(() => {
  for (const t of tables) sqlite.prepare(`delete from ${t}`).run();
})();
sqlite.close();
console.log('Posta cancellata: verrà reimportata al prossimo avvio del server.');
