import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { AccountService } from '../src/accounts/service.ts';
import { ProjectService } from '../src/projects/service.ts';

describe('categorie dei progetti', () => {
  it('ordinano la barra laterale; eliminata una categoria, i suoi progetti restano senza categoria', () => {
    const { db } = openDb(':memory:');
    runMigrations(db);
    const svc = new ProjectService(db);
    const accountId = new AccountService(db).create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' }).id;

    const lavoro = svc.createCategory({ name: 'Lavoro' });
    const personale = svc.createCategory({ name: 'Personale' });
    expect(svc.categories().map((c) => c.name)).toEqual(['Lavoro', 'Personale']);

    const a = svc.create({ name: 'MUSA', outgoingAccountId: accountId, categoryId: lavoro.id });
    const b = svc.create({ name: 'Salute', outgoingAccountId: accountId });
    const c = svc.create({ name: 'Eloquence', outgoingAccountId: accountId });
    expect(a.categoryId).toBe(lavoro.id);
    expect(b.categoryId).toBeNull();
    expect(() => svc.create({ name: 'X', outgoingAccountId: accountId, categoryId: 'nope' })).toThrow();

    // Modalità Gestione: Personale prima di Lavoro, Salute in Personale, Eloquence sopra MUSA.
    svc.saveLayout({
      categories: [personale.id, lavoro.id],
      projects: [
        { id: b.id, categoryId: personale.id },
        { id: c.id, categoryId: lavoro.id },
        { id: a.id, categoryId: lavoro.id },
      ],
    });
    expect(svc.categories().map((x) => x.name)).toEqual(['Personale', 'Lavoro']);
    expect(svc.list().map((p) => [p.name, p.categoryId])).toEqual([
      ['Salute', personale.id],
      ['Eloquence', lavoro.id],
      ['MUSA', lavoro.id],
    ]);
    expect(() => svc.saveLayout({ categories: [], projects: [{ id: a.id, categoryId: 'nope' }] })).toThrow();

    expect(svc.updateCategory(lavoro.id, { collapsed: true, name: 'Lavoro CNR' })).toMatchObject({ name: 'Lavoro CNR', collapsed: true });

    svc.deleteCategory(lavoro.id);
    expect(svc.categories().map((x) => x.name)).toEqual(['Personale']);
    expect(svc.get(a.id)!.categoryId).toBeNull();
    expect(svc.get(c.id)!.categoryId).toBeNull();
  });
});
