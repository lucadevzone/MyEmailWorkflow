# My Email Workflow

Client di posta personale **organizzato per progetti**, non per cartelle. Ogni conversazione sta in un progetto (o in *Da smistare*), insieme alle persone, ai task, alle note e ai file che la riguardano. Un modello linguistico **locale** ([Ollama](https://ollama.com)) riassume le conversazioni, propone dove smistarle e quali task nascono dalle mail: nessun dato esce dal computer.

> Progetto personale in sviluppo attivo, pensato per macOS (le password stanno nel Portachiavi). Interfaccia in italiano.

## Cosa fa

**Progetti e smistamento**
- Barra laterale con i progetti raggruppati per **categorie**, comprimibile; *Da smistare* in cima, *News* e *Spam* in fondo.
- L'assistente propone in quale progetto spostare una conversazione; con lo **smistamento automatico** lo fa da solo quando la regola si è dimostrata affidabile.
- Dopo uno spostamento o un'archiviazione propone le **conversazioni simili** (stesso mittente, contenuto simile).
- Filtro **News** (newsletter e pubblicità) e **Spam**, con **regole per mittente** applicabili anche alla posta già arrivata.
- **Selezione multipla** con azioni cumulative: letta/da leggere, sposta, **unisci**, archivia.

**Conversazioni**
- Righe compatte di una sola riga; la conversazione aperta mostra sintesi, struttura dei messaggi, suggerimenti dell'assistente, task e note, risorse.
- **Allegati versionati**: le nuove versioni di uno stesso file si riconoscono e si consultano in linea.
- Viste *Attive*, *Importanti* (segnalibro, sincronizzato con la stella di Gmail) e *Archiviate*.
- **Stacca** un messaggio in una conversazione nuova, o **unisci** più conversazioni.

**Task**
- Ogni progetto, e anche *Da smistare*, ha la sua lista di task ordinabile, con scadenze.
- Task suggeriti dall'assistente e *Ricordami di rispondere*, che si chiude da solo quando rispondi.

**Scrittura e invio**
- Vista Email a carosello sull'intera conversazione, con la bozza in fondo.
- Composizione in HTML o testo, **firme** scelte per progetto, account di uscita per progetto.
- Gli invii e le modifiche su Gmail passano da una **coda di attività** eseguita a intervalli: c'è tempo per ripensarci (*Blocca invio*).

**Assistente (LLM locale)**
- Chat sulla conversazione o sulla bozza: riassumere, cosa richiede risposta, estrarre task, tradurre, riformulare (anche solo un pezzo selezionato).
- Ricerca unica su conversazioni, persone, allegati, task e note, anche **per significato**; l'assistente risponde citando le mail.
- L'analisi in background si fa solo sulla **posta recente** (90 giorni, impostabile fino a "tutta"); per la posta più vecchia la sintesi si genera su richiesta. Può essere messa **in pausa**: la posta appena ricevuta e le conversazioni che apri si analizzano comunque.

**Uso su più PC**
- Si può usare l'app su più Mac, **uno alla volta**, attraverso una cartella condivisa (per esempio su Google Drive).
- Viaggiano solo i **dati personali** (progetti, task, note, regole, contatti, stato delle conversazioni, coda degli invii), pochi MB compressi, più i file che hai caricato tu; la posta ogni PC la scarica da Gmail.
- Un **semaforo** nella cartella dice chi ha il database: l'altro PC resta in sola lettura e può chiederlo con *Usa qui*. Il database si consegna e si libera alla chiusura, dopo 10 minuti senza uso (impostabile) e a richiesta; ogni 10 minuti c'è una consegna di sicurezza.
- Sul secondo Mac la procedura di benvenuto ha la scelta *Ho già l'app su un altro PC*: cartella condivisa, dati personali, password degli account; la posta che arriva da Gmail va subito nel progetto giusto.

## Requisiti

- **macOS** (le password degli account sono salvate nel Portachiavi)
- **Node.js 26** (`nvm use`) e **pnpm 12** (`npm install -g pnpm`)
- **Ollama** con i due modelli predefiniti:
  ```bash
  ollama pull llama3.1:8b
  ollama pull bge-m3
  ```
  Su un Mac con 16 GB di memoria si consiglia un solo modello linguistico alla volta.
- Un account **Gmail** con la verifica in due passaggi e una **password per le app** (Account Google → Sicurezza → Password per le app). Si può aggiungere anche un account IMAP/SMTP generico (Impostazioni → Account), meno provato.

## Avvio

```bash
pnpm install
pnpm dev
```

Il backend ascolta su `127.0.0.1:4310`, l'interfaccia su <http://localhost:5173>. Al primo avvio la **procedura di benvenuto** chiede l'account di posta (la password va nel Portachiavi, mai nel database o in git) e aiuta a creare i primi progetti; l'importazione della posta parte subito, dai messaggi più recenti.

Le migrazioni del database si applicano da sole all'avvio del server.

**Su un secondo Mac**: sul primo scegli la cartella condivisa in Impostazioni → *Uso su più PC*; sul secondo, al primo avvio, scegli *Ho già l'app su un altro PC* e la stessa cartella (vedi [docs/03-uso-su-piu-pc.md](docs/03-uso-su-piu-pc.md)).

### Configurazione facoltativa

Copia `.env.example` in `.env.local` (escluso da git) solo se vuoi cambiare i valori predefiniti:

| Variabile | Predefinito | |
|---|---|---|
| `MMW_PORT` | `4310` | porta del backend (ascolta solo su 127.0.0.1) |
| `MMW_DATA_DIR` | `./data` | database SQLite e file degli allegati |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |
| `OLLAMA_LLM_MODEL` | `llama3.1:8b` | modello linguistico (si cambia anche dalle Impostazioni) |
| `OLLAMA_EMBED_MODEL` | `bge-m3` | modello per la ricerca per significato |
| `OLLAMA_NUM_CTX` | `16384` | contesto del modello |
| `MMW_TEST_EMAIL`, `MMW_TEST_APP_PASSWORD` | | solo per `pnpm check:imap` |

## Dati e privacy

- Tutto resta in locale: posta, progetti, task, note e analisi stanno in `data/` (database SQLite + allegati deduplicati), esclusa da git.
- L'LLM gira in Ollama sullo stesso computer.
- La posta resta anche sul server di posta: cancellando `data/` viene reimportata.
- Con l'uso su più PC, nella cartella condivisa finiscono il semaforo, le ultime tre versioni dei dati personali (`personale-<n>.sqlite`) e i file caricati da te (`files/`). **Per ora il file dei dati personali non è cifrato** (vedi TODO): contiene anche sintesi, bozze, invii in coda e chat con l'assistente.
- `pnpm reset:all` (con il server fermo) riporta l'app allo stato iniziale spostando i dati in una copia datata `data-backup-…` (anch'essa esclusa da git); con `--delete` li cancella insieme alle password nel Portachiavi.

## Struttura

```
server/   backend: Node + Fastify, SQLite (drizzle, FTS5, sqlite-vec), imapflow, nodemailer, Ollama
web/      interfaccia: React 19 + Vite, TanStack Query, TipTap, CSS a componenti
shared/   tipi condivisi (DTO dell'API)
docs/     requisiti, system design, uso su più PC
data/     database e allegati (creata al primo avvio, esclusa da git)
```

## Comandi

| Comando | |
|---|---|
| `pnpm dev` | backend + interfaccia con ricaricamento automatico |
| `pnpm test` | test (vitest) |
| `pnpm typecheck` | controllo dei tipi su tutti i pacchetti |
| `pnpm db:generate` | genera una migrazione dopo aver modificato `server/src/db/schema.ts` |
| `pnpm check:imap` | prova la connessione IMAP con le variabili `MMW_TEST_*` |
| `pnpm db:reset-mail` | cancella la posta importata (account e impostazioni restano); al riavvio si reimporta |
| `pnpm reset:all` | riporta l'app allo stato iniziale (vedi sopra) |
| `pnpm --filter @mmw/server eval:assistant` | banco di prova dell'assistente sulla posta di prova (`--model`, `--case`, `--runs`) |
| `pnpm --filter @mmw/server try:summary` | stampa le sintesi che l'LLM produrrebbe, senza salvarle |
| `pnpm --filter @mmw/server try:classify` | prova la classificazione su uno scenario sintetico in memoria |

## TODO

**Uso su più PC**
- [ ] Prova reale con due Mac e la cartella vera di Google Drive (finora solo test automatici e cartelle temporanee).
- [ ] Cifratura del file dei dati personali (AES-256, frase segreta nel Portachiavi di ogni Mac; il semaforo resta in chiaro). Da valutare se non far viaggiare sintesi e chat.

**Account e accesso**
- [ ] OAuth Google (XOAUTH2) al posto della password per le app, per una versione distribuibile; per Google Workspace un client OAuth *Internal* dell'organizzazione.
- [ ] Account IMAP/SMTP generico anche nella procedura di benvenuto (oggi solo da Impostazioni → Account) e più provato.

**Progetti**
- [ ] Sezione *Progetti archiviati* nelle Impostazioni, con *Riattiva* ed *Elimina definitivamente* (oggi note, task e risorse di un progetto rimosso restano legati a lui, invisibili).

**Sincronizzazione con Gmail**
- [ ] *Ripristina dall'archivio* anche su Gmail (oggi è solo locale: su Gmail resta archiviata finché non arriva posta nuova).
- [ ] Riflettere nell'app le cancellazioni fatte altrove (expunge sul server).

**Assistente**
- [ ] RF-B6: proporre un gruppo quando un insieme di destinatari ricorre spesso (priorità bassa).
- [ ] RF-D6 v3: riconoscere le versioni di un file anche dal contenuto simile (PDF, immagini) — da progettare prima.

**Prestazioni** (solo se torna la lentezza)
- [ ] Spostare il testo delle mail (≈300 MB) fuori dalla tabella `messages`.
- [ ] Lista dei progetti più veloce (oggi ~100 ms).

**Piattaforma**
- [ ] App desktop impacchettata (Electron o Tauri con il server come processo separato): avvio e arresto del server con l'app, scelta della cartella dei dati, moduli nativi (better-sqlite3, sqlite-vec, Portachiavi) per Intel e Apple Silicon.
- [ ] Versione mobile (futuro).

## Documentazione

- [Requisiti](docs/01-requisiti.md)
- [System design](docs/02-system-design.md)
- [Uso su più PC](docs/03-uso-su-piu-pc.md)
