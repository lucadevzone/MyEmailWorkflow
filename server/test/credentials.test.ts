import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { AccountService } from '../src/accounts/service.ts';
import { memoryStore, resolveSecret, setSecretStore, type SecretStore } from '../src/mail/credentials.ts';

let store: SecretStore;
let accounts: AccountService;

beforeEach(() => {
  store = memoryStore();
  setSecretStore(store);
  const { db } = openDb(':memory:');
  runMigrations(db);
  accounts = new AccountService(db);
});

describe('password nel portachiavi', () => {
  it('alla creazione la password va nel portachiavi; nel DB solo il riferimento', () => {
    const a = accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', password: 'abcd efgh' });
    expect(a.credentialRef).toBe(`keychain:${a.id}`);
    expect(JSON.stringify(a)).not.toContain('abcd');
    expect(resolveSecret(a.credentialRef)).toBe('abcd efgh');
  });

  it('cambio password, eliminazione, password mancante', () => {
    const a = accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', password: 'vecchia' });
    accounts.setPassword(a.id, 'nuova');
    expect(resolveSecret(a.credentialRef)).toBe('nuova');
    accounts.remove(a.id);
    expect(store.get(a.id)).toBeNull();
    expect(() => resolveSecret(a.credentialRef)).toThrow(/Portachiavi/);
    expect(() => accounts.create({ name: 'X', email: 'x@gmail.com', provider: 'gmail' })).toThrow();
  });

  it("all'avvio sposta nel portachiavi le password ancora in env:", () => {
    process.env.MMW_TEST_SECRET_X = 'dal-file-env';
    const a = accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:MMW_TEST_SECRET_X' });
    accounts.create({ name: 'Altro', email: 'o@gmail.com', provider: 'gmail', credentialRef: 'env:MMW_NON_IMPOSTATA' });
    expect(accounts.migrateEnvCredentials()).toEqual(['me@gmail.com']);
    const moved = accounts.get(a.id)!;
    expect(moved.credentialRef).toBe(`keychain:${a.id}`);
    expect(resolveSecret(moved.credentialRef)).toBe('dal-file-env');
    delete process.env.MMW_TEST_SECRET_X;
  });

  it('firma per account: HTML e testo; vuota = nessuna firma', () => {
    const a = accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', password: 'x' });
    expect(accounts.setSignature(a.id, { html: '<p>Luca<br>ICAR-CNR</p>', text: 'Luca\nICAR-CNR' })).toMatchObject({ signatureHtml: '<p>Luca<br>ICAR-CNR</p>', signatureText: 'Luca\nICAR-CNR' });
    expect(accounts.setSignature(a.id, { html: '<p></p>', text: '  ' })).toMatchObject({ signatureHtml: null, signatureText: null });
  });
});
