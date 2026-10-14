// API dell'uso su più PC e guardiano delle modifiche: sul PC che non ha il database si può solo leggere.

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SharingError, type SharingService } from './service.ts';

export function registerSharing(app: FastifyInstance, sharing: SharingService) {
  // Sola lettura: le richieste che modificano qualcosa (tranne quelle della condivisione) si rifiutano.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.url.startsWith('/api/sharing')) return;
    if (!sharing.writable) {
      const s = sharing.status();
      const where = s.lease?.holderName ? ` su ${s.lease.holderName}` : ' su un altro PC';
      return reply.code(423).send({ error: `Il database è in uso${where}: qui si può solo consultare. Premi «Usa qui» per lavorare su questo PC.` });
    }
  });

  const handle = async <T>(fn: () => T | Promise<T>, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SharingError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  };

  app.get('/api/sharing/status', async () => sharing.status());
  app.post<{ Body: { force?: boolean } }>('/api/sharing/acquire', async (req, reply) => handle(() => sharing.acquire(!!req.body?.force), reply));
  app.post('/api/sharing/release', async (_req, reply) => handle(() => sharing.release(), reply));
  app.post('/api/sharing/deliver', async (_req, reply) => handle(() => sharing.deliver(), reply));
  app.post('/api/sharing/request-release', async (_req, reply) => handle(() => sharing.requestRelease(), reply));
  // L'interfaccia segnala che l'utente sta lavorando (per il rilascio dopo N minuti senza uso).
  app.post('/api/sharing/activity', async () => {
    sharing.markActivity();
    return { ok: true };
  });
  app.put('/api/sharing/folder', async (req, reply) => {
    const body = z.object({ folder: z.string().nullable(), copy: z.boolean().optional(), join: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Cartella non valida' });
    return handle(() => sharing.setFolder(body.data), reply);
  });
  app.put('/api/sharing/machine', async (req, reply) => {
    const body = z.object({ name: z.string().max(60).optional(), idleReleaseMinutes: z.number().int().min(0).max(24 * 60).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Valori non validi' });
    return sharing.setMachine(body.data);
  });
  // Cartelle di Google Drive (Google Drive per desktop) trovate su questo Mac, da proporre nella scelta.
  app.get('/api/sharing/suggested-folders', async () => {
    const base = path.join(os.homedir(), 'Library', 'CloudStorage');
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('GoogleDrive-')) continue;
      for (const sub of ['My Drive', 'Il mio Drive']) {
        const p = path.join(base, d, sub);
        if (fs.existsSync(p)) out.push(path.join(p, 'MyEmailWorkflow'));
      }
    }
    return out;
  });
}
