import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { AccountService } from '../src/accounts/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { SignatureService } from '../src/signatures/service.ts';

describe('firme', () => {
  it('si definiscono con un nome, il progetto ne sceglie una; eliminata, il progetto resta senza firma', () => {
    const { db } = openDb(':memory:');
    runMigrations(db);
    const sigs = new SignatureService(db);
    const projects = new ProjectService(db);
    const accountId = new AccountService(db).create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;

    const lavoro = sigs.create({ label: 'Lavoro', html: '<p>Luca<br>ICAR-CNR</p>', text: 'Luca\nICAR-CNR' });
    sigs.create({ label: 'Amici', html: '<p>Luca</p>', text: 'Luca' });
    expect(sigs.list().map((s) => s.label)).toEqual(['Amici', 'Lavoro']);
    expect(() => sigs.create({ label: '', html: '', text: 'x' })).toThrow();

    const p = projects.create({ name: 'PNRR', outgoingAccountId: accountId, signatureId: lavoro.id });
    expect(p.signatureId).toBe(lavoro.id);
    expect(projects.update(p.id, { signatureId: null })!.signatureId).toBeNull();
    projects.update(p.id, { signatureId: lavoro.id });

    sigs.update(lavoro.id, { label: 'Lavoro CNR', html: '<p>Luca S.</p>', text: 'Luca S.' });
    expect(sigs.get(lavoro.id)!.label).toBe('Lavoro CNR');
    sigs.remove(lavoro.id);
    expect(sigs.list().map((s) => s.label)).toEqual(['Amici']);
    expect(projects.get(p.id)!.signatureId).toBeNull();
  });
});
