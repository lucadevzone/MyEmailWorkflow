import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ProjectService } from '../src/projects/service.ts';
import { SharingService } from '../src/sharing/service.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-lease-'));

/** Un "PC" con il suo database, i suoi processi che scrivono (finti) e il suo nome. */
function pc(name: string) {
  const dir = tmp();
  const { db, sqlite } = openDb(path.join(dir, 'mmw.sqlite'));
  runMigrations(db);
  const s = buildServices(db, sqlite, path.join(dir, 'blobs'), {
    createProvider: () => {
      throw new Error('niente IMAP');
    },
  });
  const writers = { on: false, start() { this.on = true; }, async stop() { this.on = false; } };
  const sharing = new SharingService({ sqlite, dataDir: dir, writers, log: () => {} });
  sharing.setMachine({ name });
  return { s, sharing, writers, projects: new ProjectService(db) };
}
const tick = (p: ReturnType<typeof pc>) => (p.sharing as unknown as { tick: () => Promise<void> }).tick();

describe('semaforo nella cartella condivisa', () => {
  it('un PC alla volta: chi aspetta è in sola lettura, chiede il rilascio, prende e trova i dati', async () => {
    const shared = tmp();
    const A = pc('MacBook-ufficio');
    const accountId = A.s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'keychain:x' }).id;
    A.projects.create({ name: 'Gare', outgoingAccountId: accountId });
    await A.sharing.init();
    expect(A.sharing.status().state).toBe('disabled');
    expect(A.writers.on).toBe(true);

    // A inaugura la cartella: ha il database e consegna subito la versione 1.
    await A.sharing.setFolder({ folder: shared });
    expect(A.sharing.status()).toMatchObject({ state: 'holder', localVersion: 1, lease: { holderName: 'MacBook-ufficio', version: 1 } });
    expect(fs.existsSync(path.join(shared, 'personale-1.sqlite'))).toBe(true);

    // B si collega: il database è occupato, quindi aspetta in sola lettura.
    const B = pc('MacBook-casa');
    await B.sharing.init();
    await B.sharing.setFolder({ folder: shared });
    expect(B.sharing.status()).toMatchObject({ state: 'waiting', holderStale: false });
    expect(B.sharing.writable).toBe(false);
    expect(B.writers.on).toBe(false);
    await expect(B.sharing.acquire()).rejects.toThrow('in uso su MacBook-ufficio');

    // B chiede il rilascio; A, al suo giro, consegna e libera.
    B.sharing.requestRelease();
    A.projects.create({ name: 'Salute', outgoingAccountId: accountId });
    await tick(A);
    expect(A.sharing.status()).toMatchObject({ state: 'waiting', lease: { holderId: null, version: 2 } });
    expect(A.writers.on).toBe(false);

    // B prende: importa la versione 2 e lavora.
    await B.sharing.acquire();
    expect(B.sharing.status()).toMatchObject({ state: 'holder', localVersion: 2 });
    expect(B.writers.on).toBe(true);
    expect(B.projects.list().map((p) => p.name).sort()).toEqual(['Gare', 'Salute']);

    // Rilascio volontario: se nulla è cambiato, la versione resta la stessa.
    await B.sharing.release();
    expect(B.sharing.status()).toMatchObject({ state: 'waiting', lease: { holderId: null, version: 2 } });
    await A.sharing.acquire();
    expect(A.sharing.status()).toMatchObject({ state: 'holder', localVersion: 2 });
  });

  it('PC spento di colpo: dopo 5 minuti senza segnale si può prendere comunque; quello vecchio smette di scrivere', async () => {
    const shared = tmp();
    const A = pc('A');
    await A.sharing.init();
    await A.sharing.setFolder({ folder: shared });
    const B = pc('B');
    await B.sharing.init();
    await B.sharing.setFolder({ folder: shared });
    await expect(B.sharing.acquire(true)).rejects.toThrow('in uso'); // A è vivo
    // Segnale di vita vecchio di 6 minuti.
    const leaseFile = path.join(shared, 'semaforo.json');
    const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, heartbeat: Date.now() - 6 * 60_000 }));
    expect(B.sharing.status().holderStale).toBe(true);
    await B.sharing.acquire(true);
    expect(B.sharing.status().state).toBe('holder');
    // A si risveglia e vede che il database è di B.
    await tick(A);
    expect(A.sharing.status().state).toBe('waiting');
    expect(A.writers.on).toBe(false);
  });

  it('rilascio dopo N minuti senza uso; consegna in arrivo non ancora scaricata da Drive', async () => {
    const shared = tmp();
    const A = pc('A');
    await A.sharing.init();
    await A.sharing.setFolder({ folder: shared });
    A.sharing.setMachine({ idleReleaseMinutes: 1 });
    (A.sharing as unknown as { lastActivity: number }).lastActivity = Date.now() - 2 * 60_000;
    await tick(A);
    expect(A.sharing.status().state).toBe('waiting');

    // Il semaforo annuncia la versione 5, ma il file non c'è ancora: si aspetta.
    const leaseFile = path.join(shared, 'semaforo.json');
    const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, version: 5, file: 'personale-5.sqlite', sha256: 'x', size: 10 }));
    const B = pc('B');
    await B.sharing.init();
    await B.sharing.setFolder({ folder: shared });
    expect(B.sharing.status().state).toBe('syncing');
    expect(B.writers.on).toBe(false);
  });
});
