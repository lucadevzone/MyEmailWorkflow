import type { FastifyInstance } from 'fastify';

// Protezioni per un server su localhost:
// - Host: blocca il DNS rebinding (un sito esterno che risolve il suo dominio a 127.0.0.1).
// - Header X-MMW sulle richieste che modificano stato: un sito esterno non può impostarlo
//   senza un preflight CORS, che il server non concede.
export function registerSecurity(app: FastifyInstance, port: number) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const devHosts = /^(127\.0\.0\.1|localhost):\d+$/;

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    // In sviluppo il proxy di Vite inoltra con il proprio Host (localhost:5173).
    if (!allowedHosts.has(host) && !devHosts.test(host)) {
      return reply.code(403).send({ error: 'Host non consentito' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-mmw'] !== '1') {
      return reply.code(403).send({ error: 'Header X-MMW mancante' });
    }
  });
}
