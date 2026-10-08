// Sviluppo: prova la classificazione con i veri modelli Ollama su uno scenario sintetico,
// in un database in memoria (i dati reali non vengono toccati).
// Uso: pnpm --filter @mmw/server try:classify
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage } from '../src/ingest/ingest.ts';
import { ProjectService } from '../src/projects/service.ts';
import { ConversationService } from '../src/conversations/service.ts';

const { db, sqlite } = openDb(':memory:');
runMigrations(db);
const s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-try-')), {
  createProvider: () => {
    throw new Error('no imap');
  },
});
const acc = s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' });
const projects = new ProjectService(db);
const pnrr = projects.create({ name: 'PNRR FAIR', description: 'Progetto PNRR FAIR: rendicontazione, deliverable, riunioni di WP con i partner', outgoingAccountId: acc.id }).id;
const corso = projects.create({ name: 'Basi di dati', description: 'Corso universitario di Basi di dati: lezioni, esami, studenti, tesi', outgoingAccountId: acc.id }).id;
const conv = new ConversationService(db);

let uid = 1;
const mail = (id: string, from: string, subject: string, body: string) =>
  ingestMessage(s, acc, {
    uid: uid++, mailbox: 'All', flags: [], labels: [],
    source: Buffer.from(`Message-ID: <${id}@x>\r\nFrom: ${from}\r\nTo: me@gmail.com\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`),
  });

// Storico già smistato
for (const [id, from, subj, body, p] of [
  ['h1', 'Mario Rossi <mario.rossi@cnr.it>', 'Deliverable D3.2', 'Ciao Luca, ti ricordo la scadenza del deliverable D3.2 del WP3. Serve la tua sezione entro fine mese.', pnrr],
  ['h2', 'Anna Verdi <anna.verdi@unipa.it>', 'Riunione WP3', 'Propongo la riunione di WP3 con i partner martedì alle 10 su Teams.', pnrr],
  ['h3', 'Segreteria didattica <didattica@unipa.it>', 'Calendario esami', 'Si prega di inserire le date degli appelli di Basi di dati entro venerdì.', corso],
  ['h4', 'Giulia Bianchi <giulia.b@studenti.unipa.it>', 'Richiesta tesi', 'Buongiorno professore, vorrei svolgere la tesi sul suo corso di basi di dati.', corso],
] as const) {
  const r = await mail(id, from, subj, body);
  s.actions.move(r.conversationId, p);
}
await s.jobs.drain();

// Posta nuova da smistare
const tests = [
  ['n1', 'Mario Rossi <mario.rossi@cnr.it>', 'Rendiconto spese', 'Luca, per la rendicontazione del secondo semestre mi mandi i timesheet di settembre?'],
  ['n2', 'Marco Neri <marco.neri@studenti.unipa.it>', 'Esame del 12', 'Salve, non riesco a iscrivermi all\'appello del 12 di basi di dati, il portale dà errore.'],
  ['n3', 'Paolo Gialli <paolo@ordine-ingegneri.it>', 'Convegno ordine ingegneri', 'Gentile ingegnere, la invitiamo a tenere un intervento al convegno annuale dell\'ordine su IA e professioni.'],
  ['n4', 'Anna Verdi <anna.verdi@unipa.it>', 'Deliverable D4.1', 'Ciao Luca, entro venerdì mi servono la tua sezione del D4.1 e la lista delle pubblicazioni del 2026. Ci sentiamo martedì per la riunione di WP4.'],
] as const;
for (const [id, from, subj, body] of tests) {
  const t = Date.now();
  const r = await mail(id, from, subj, body);
  await s.jobs.drain();
  const item = conv.list({ view: 'inbox' }).find((c) => c.id === r.conversationId);
  const sug = item?.suggestions.find((x) => x.kind === 'project' || x.kind === 'new_project');
  const taskSugs = item?.suggestions.filter((x) => x.kind === 'task') ?? [];
  console.log(`== ${subj}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  console.log(sug ? `   → ${sug.kind === 'project' ? 'Sposta in' : 'Nuovo progetto'} ${sug.payload.projectName} · ${Math.round((sug.confidence ?? 0) * 100)}%\n     motivo: ${sug.payload.reason}` : '   → nessun suggerimento di progetto');
  for (const t of taskSugs) console.log(`   + task: ${t.payload.title}${t.payload.dueDate ? ` (entro ${t.payload.dueDate})` : ''}`);
}
s.jobs.stop();
