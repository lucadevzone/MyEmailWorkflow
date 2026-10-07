import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';

const PORT = 4310;
const HOST = { host: `127.0.0.1:${PORT}` };
const MUTATE = { ...HOST, 'x-mmw': '1' };
const WRITE = { ...MUTATE, 'content-type': 'application/json' };

let ctx: ReturnType<typeof openDb>;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  ctx = openDb(':memory:');
  runMigrations(ctx.db);
  app = buildApp({ ...ctx, port: PORT });
});
afterEach(async () => {
  await app.close();
  ctx.sqlite.close();
});

describe('database', () => {
  it('crea le tabelle virtuali FTS5 e sqlite-vec', () => {
    const names = ctx.sqlite
      .prepare("select name from sqlite_master where name in ('message_fts','chunk_vec')")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(names).toEqual(['chunk_vec', 'message_fts']);
    ctx.sqlite.prepare('insert into chunk_vec(chunk_id, embedding) values (?, ?)').run('c1', new Float32Array(1024).fill(0.1));
    const hit = ctx.sqlite
      .prepare('select chunk_id from chunk_vec where embedding match ? and k = 1')
      .get(new Float32Array(1024).fill(0.1)) as { chunk_id: string };
    expect(hit.chunk_id).toBe('c1');
  });
});

describe('sicurezza', () => {
  it('rifiuta Host non locali', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: { host: 'evil.example:4310' } });
    expect(res.statusCode).toBe(403);
  });
  it('rifiuta scritture senza X-MMW', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: HOST, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('account', () => {
  it('crea un account Gmail con i default e lo elimina', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: WRITE,
      payload: { name: 'Prova', email: 'prova@gmail.com', provider: 'gmail', credentialRef: 'env:MMW_TEST_APP_PASSWORD' },
    });
    expect(created.statusCode).toBe(201);
    const acc = created.json();
    expect(acc).toMatchObject({ imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', username: 'prova@gmail.com' });

    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: HOST })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/accounts/${acc.id}`, headers: MUTATE })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: HOST })).json()).toHaveLength(0);
  });

  it('rifiuta credenziali in chiaro', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: WRITE,
      payload: { name: 'X', email: 'x@gmail.com', provider: 'gmail', credentialRef: 'abcd efgh ijkl mnop' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('richiede gli host per IMAP generico', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: WRITE,
      payload: { name: 'X', email: 'x@example.org', provider: 'imap', credentialRef: 'env:X' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('impostazioni', () => {
  it('restituisce i default e salva le modifiche', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: HOST })).json().activityBatchMinutes).toBe(5);
    const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: WRITE, payload: { activityBatchMinutes: 10 } });
    expect(res.json().activityBatchMinutes).toBe(10);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: HOST })).json().activityBatchMinutes).toBe(10);
  });
});
