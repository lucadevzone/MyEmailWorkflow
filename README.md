# my mail workflow

Client di posta personale organizzato per progetti e persone, con analisi AI locale (Ollama).

- Requisiti: [docs/01-requisiti.md](docs/01-requisiti.md)
- Design: [docs/02-system-design.md](docs/02-system-design.md)

## Struttura

```
server/   backend Node + Fastify + SQLite (drizzle, sqlite-vec, imapflow)
web/      interfaccia React + Vite + Tailwind
shared/   tipi condivisi (DTO dell'API)
data/     database e blob (creata al primo avvio, esclusa da git)
```

## Avvio

Requisiti: Node 26 (`nvm use`), pnpm 12 (`npm install -g pnpm`), Ollama con `llama3.1:8b` e `bge-m3`.

```bash
pnpm install
cp .env.example .env.local   # poi compila MMW_TEST_EMAIL e MMW_TEST_APP_PASSWORD
pnpm check:imap              # verifica la connessione all'account di prova
pnpm dev                     # backend su :4310, interfaccia su http://127.0.0.1:5173
```

Le migrazioni del database vengono applicate all'avvio del server.

### App password Gmail (account di prova)

1. Attiva la verifica in due passaggi sull'account Google.
2. Genera una app password: Account Google → Sicurezza → Password per le app.
3. Copiala in `.env.local` come `MMW_TEST_APP_PASSWORD`.
4. In Impostazioni → Account aggiungi l'account con credenziale `env:MMW_TEST_APP_PASSWORD`.

Le credenziali non vanno mai nel database né in git: il DB conserva solo il riferimento (`env:NOME`).

## Comandi

| Comando | |
|---|---|
| `pnpm dev` | backend + interfaccia in watch |
| `pnpm test` | test |
| `pnpm typecheck` | controllo dei tipi su tutti i pacchetti |
| `pnpm db:generate` | genera una migrazione dopo aver modificato `server/src/db/schema.ts` |
| `pnpm check:imap` | test di connessione IMAP all'account di prova |
