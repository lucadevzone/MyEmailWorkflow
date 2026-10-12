// Riporta l'app allo stato di una installazione nuova: nessun account, progetto, posta o impostazione.
// Al prossimo avvio si apre la procedura di benvenuto.
//
//   pnpm reset:all            sposta la cartella dei dati in una copia datata (si può tornare indietro)
//   pnpm reset:all --delete   cancella per sempre la cartella e le password degli account dal Portachiavi
//   aggiungere --yes per non chiedere conferma
//
// Va eseguito con il server fermo. La posta resta sul server di posta: verrà reimportata.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import Database from 'better-sqlite3';
import { config } from '../src/config.ts';
import { forgetSecret } from '../src/mail/credentials.ts';

const permanent = process.argv.includes('--delete');
const yes = process.argv.includes('--yes');
const dir = config.dataDir;

async function serverRunning(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

if (await serverRunning()) {
  console.error(`Il server è in esecuzione sulla porta ${config.port}: fermalo prima (Ctrl+C su "pnpm dev").`);
  process.exit(1);
}
if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
  console.log(`La cartella dei dati (${dir}) è già vuota: l'app è allo stato di partenza.`);
  process.exit(0);
}

// Cosa si perde: lo si dice prima di chiedere conferma.
let summary = '';
let refs: string[] = [];
if (fs.existsSync(config.dbPath)) {
  const db = new Database(config.dbPath, { readonly: true });
  const count = (sql: string) => {
    try {
      return (db.prepare(sql).get() as { n: number }).n;
    } catch {
      return 0;
    }
  };
  refs = (db.prepare('select credential_ref as r from accounts where deleted_at is null').all() as { r: string }[]).map((x) => x.r);
  summary =
    `${refs.length} account, ${count('select count(*) as n from projects where deleted_at is null')} progetti, ` +
    `${count('select count(*) as n from conversations where deleted_at is null')} conversazioni, ` +
    `${count('select count(*) as n from tasks where deleted_at is null')} task, ${count('select count(*) as n from notes where deleted_at is null')} note`;
  db.close();
}

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const backup = `${dir.replace(/\/+$/, '')}-backup-${stamp}`;
console.log(`Cartella dei dati: ${dir}${summary ? `\nContiene: ${summary}` : ''}`);
console.log(
  permanent
    ? 'Verrà CANCELLATA per sempre, insieme alle password degli account nel Portachiavi.'
    : `Verrà spostata in: ${backup}\n(per tornare indietro: ferma il server e rinomina quella cartella in ${path.basename(dir)})`,
);

if (!yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Scrivi ${permanent ? 'CANCELLA' : 'RESET'} per confermare: `);
  rl.close();
  if (answer.trim() !== (permanent ? 'CANCELLA' : 'RESET')) {
    console.log('Annullato: non è cambiato nulla.');
    process.exit(0);
  }
}

if (permanent) {
  for (const r of refs) forgetSecret(r);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Dati cancellati.');
} else {
  // Le password restano nel Portachiavi: servono se si ripristina la copia.
  fs.renameSync(dir, backup);
  console.log(`Dati spostati in ${backup}.`);
}
console.log('Al prossimo avvio (pnpm dev) l\'app riparte da zero con la procedura di benvenuto.');
