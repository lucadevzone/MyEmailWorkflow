# System design — my_mail_workflow

Versione 0.1 — 2026-10-07. Riferimento: `01-requisiti.md`.

## 1. Architettura

```
┌──────────────────────────── Browser (poi Electron renderer) ───────────────────────────┐
│  UI React: Da smistare · Progetti · Persone (bolle) · Task · Attività · Suggerimenti     │
└───────────────▲──────────────────────────────────────────────────▲──────────────────────┘
                │ REST (comandi/query)                             │ SSE (eventi live)
┌───────────────┴──────────────── Backend Node/TypeScript (localhost) ┴─────────────────────┐
│                                                                                           │
│  API layer ──► Domain services (Progetti, Conversazioni, Contatti, Task, Note, Risorse)   │
│                        │                                                                  │
│   ┌────────────────────┼──────────────────────────────────────────────┐                   │
│   │                    ▼                                              │                   │
│   │  Sync engine ◄── Mail provider adapter (Gmail IMAP / IMAP generico / SMTP)            │
│   │      │                                   ▲                        │                   │
│   │      ▼                                   │                        │                   │
│   │  Ingest pipeline: parse → threading → contatti → [job analisi]    │                   │
│   │                                          │                        │                   │
│   │  Activity queue (coda utente, batch ogni N min) ──────────────────┘                   │
│   │                                                                                       │
│   │  Job runner (coda interna) ──► Analyzer ──► Ollama (LLM + embedding)                  │
│   └───────────────────────────────────────────────────────────────────┘                   │
│                        │                                                                  │
│        SQLite (metadati + FTS5 + sqlite-vec)        Blob store su disco (.eml, allegati)  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Ci sono due code distinte:
- **Activity queue**: visibile all'utente, contiene operazioni con effetti esterni, annullabili.
- **Job queue**: interna e invisibile. Contiene il lavoro di background: parsing, analisi AI, embedding, backfill.

## 2. Stack proposto

| Strato | Scelta | Motivo |
|---|---|---|
| Linguaggio | TypeScript end-to-end | Un solo linguaggio; Electron è Node |
| Backend | Node + Fastify | Leggero, tipizzato |
| IMAP | `imapflow` | Moderno, supporta IDLE, CONDSTORE ed estensioni Gmail (`X-GM-THRID`) |
| SMTP | `nodemailer` | Standard de facto |
| Parsing | `mailparser` | MIME, allegati, header |
| DB | SQLite (`better-sqlite3`) + Drizzle ORM | Un file, zero amministrazione, perfetto in Electron |
| Ricerca testuale | SQLite FTS5 | Integrata |
| Vettori | `sqlite-vec` | Embedding nello stesso DB, niente servizi esterni |
| AI | Ollama via HTTP | LLM e embedding configurabili |
| Frontend | React + Vite + TanStack Query + Tailwind | Standard, veloce da sviluppare |
| Monorepo | pnpm workspaces: `server/`, `web/`, `shared/` (tipi comuni) | |

**Modelli Ollama** (configurabili):
- Embedding multilingue (posta in italiano e inglese): `bge-m3`.
- LLM: si sceglie in configurazione, default `llama3.1:8b`, con output JSON strutturato.

## 3. Accesso alla posta

**Decisione proposta**: un unico adapter IMAP/SMTP con le estensioni Gmail attive quando presenti.
- Gmail via IMAP + **app password** nell'MVP (richiede la verifica in due passaggi). OAuth2 (XOAUTH2) arriva dopo, senza cambiare l'adapter.
- Su Gmail si sincronizza **`[Gmail]/All Mail`**. Contiene ricevute e inviate, incluse quelle mandate dal telefono (RF-A4), e `X-GM-MSGID` evita i duplicati tra cartelle.
- IMAP generico: si sincronizzano INBOX e Sent. Viene quasi gratis.

Interfaccia:

```ts
interface MailProvider {
  connect(): Promise<void>;
  listMailboxes(): Promise<Mailbox[]>;
  fetchRange(mailbox, range: UidRange | DateRange): AsyncIterable<RawMessage>;
  watch(onChange): Unsubscribe;               // IDLE + CONDSTORE
  setFlags(ref, flags): Promise<void>;        // letto, star
  moveToTrash(ref): Promise<void>;
  archive(ref): Promise<void>;
  send(mime: Buffer, account): Promise<SentRef>;  // SMTP; Gmail salva da solo in Inviati
}
```

## 4. Strategia di sincronizzazione

1. **Fase recente**: ultimi 90 giorni, configurabile. Questi messaggi vengono parsati, collegati in conversazioni e analizzati subito.
2. **Backfill**: si procede a ritroso un mese alla volta, in background e a bassa priorità.
   - I messaggi storici vengono indicizzati: parsing, threading, contatti, embedding.
   - Non generano suggerimenti di task: un task di tre anni fa è rumore.
   - Lo storico smistato in blocco è il terreno della modalità *organizza tu*.
3. **Incrementale**: IMAP IDLE per i nuovi messaggi, CONDSTORE/MODSEQ per i flag cambiati altrove.
4. Lo stato di avanzamento per account e cartella (`uidvalidity`, `last_uid`, `oldest_synced_date`, `modseq`) vive nel DB. Il sync riprende da dove si era fermato.

Il server di posta resta la **fonte di verità per i messaggi grezzi**. L'app è la fonte di verità per progetti, note, task e annotazioni, che non vengono mai scritti sul server.

## 5. Modello dati

Tutti gli ID sono ULID. Ogni entità applicativa ha `created_at`, `updated_at` e `deleted_at` (tombstone, per il sync futuro).

```
account(id, name, email, provider, imap_*, smtp_*, credential_ref, color)
sync_state(account_id, mailbox, uidvalidity, last_uid, modseq, oldest_synced_date)

project(id, name, description, outgoing_account_id, archived, color)

conversation(id, project_id NULL=Da smistare, subject, summary, summary_updated_at,
             last_message_at, gm_thread_id NULL, is_noise)

message(id, conversation_id, account_id, direction in|out,
        rfc_message_id, in_reply_to, references[], gm_msgid,
        from_address, subject, date, snippet,
        body_text, body_text_clean   -- senza testo quotato né firma
        raw_blob_sha, html_blob_sha, flags, analyzed_at)
message_address(message_id, contact_address_id, role from|to|cc|bcc)

contact(id, display_name, avatar_blob_sha, notes)
contact_address(id, contact_id NULL=sconosciuto, email, last_seen_at)
contact_group(id, name) ; group_member(group_id, contact_id)

blob(sha256 PK, size, mime)          -- storage content-addressed su disco
attachment(id, message_id, blob_sha, filename, mime, size, version_chain_id NULL, version_no)
version_chain(id, conversation_id, logical_name)              -- POST

resource(id, project_id, conversation_id NULL, kind file|link, blob_sha|url, title)
note(id, project_id, conversation_id NULL, annotation_id NULL, body)
annotation(id, message_id, quote_exact, quote_prefix, quote_suffix,
           start_offset, end_offset, label, comment)           -- POST
task(id, project_id NULL, conversation_id NULL, message_id NULL, annotation_id NULL,
     title, details, status open|done, rank, priority NULL, due_date NULL)

suggestion(id, kind, subject_type, subject_id, payload JSON, confidence,
           status pending|accepted|rejected|auto_applied, model, created_at)
activity(id, kind, payload JSON, status pending|running|done|failed|cancelled,
         urgent, scheduled_for, attempts, last_error, undo_payload JSON)
job(id, kind, payload, priority, status, attempts, run_after)   -- coda interna

message_fts   (FTS5 su subject, body_text_clean, from)
chunk(id, message_id, ord, text) ; chunk_vec (sqlite-vec, dim 1024)
```

**Invarianti**
- Il progetto di un messaggio si ricava **sempre** da `conversation.project_id`, non viene salvato sul messaggio. Così la regola "tutte le email di una conversazione stanno nello stesso progetto" vale per costruzione.
- Note, task e risorse legati a una conversazione seguono la conversazione quando questa viene spostata. Se li sposti da soli in un altro progetto, perdono il legame con la conversazione.
- Spostare una singola email significa crearle una nuova conversazione nel progetto di destinazione.

**Ordinamento dei task**: `rank` usa il fractional indexing (stringhe ordinabili), quindi riordinare tocca una sola riga. Un task nuovo prende un rank dopo l'ultimo. Con `priority` impostata viene inserito in cima, o in testa alla sua fascia di priorità.

**Annotazioni**: per l'ancoraggio si usa il modello W3C Web Annotation (TextQuoteSelector + TextPositionSelector). Le annotazioni restano agganciate anche se cambia il rendering del testo.

## 6. Flussi principali

### 6.1 Email in arrivo
```
IDLE/fetch → salva raw (blob) → parse → dedup (gm_msgid / Message-ID)
  → threading: gm_thread_id, poi In-Reply-To/References, poi oggetto normalizzato + partecipanti
     ├─ conversazione esistente → eredita il progetto (nessuna AI necessaria)
     └─ conversazione nuova    → project_id = NULL (Da smistare)
  → risoluzione contatti (indirizzi sconosciuti → contact_address senza contatto)
  → job: analyze(message)   [priorità alta se recente, bassa se backfill]
  → evento SSE alla UI
```

### 6.2 Pipeline dell'analizzatore (job `analyze`)
1. **Pulizia**: rimuove testo quotato e firme, producendo `body_text_clean`. È fondamentale: senza questo passo ogni risposta duplica il thread negli embedding e nei riassunti.
2. **Rumore**: euristiche su `List-Unsubscribe`, `Precedence: bulk` e mittenti no-reply, più l'LLM nei casi dubbi. Imposta `conversation.is_noise`.
3. **Embedding**: divide il testo in chunk (~500 token) e chiama `bge-m3`.
4. **Progetto** (solo per conversazioni nuove). La classificazione è ibrida, per restare economica e spiegabile:
   - *prior sui contatti*: in quali progetti compaiono i partecipanti;
   - *kNN*: i vicini più simili tra le email già assegnate, con voto per progetto;
   - *LLM*: riceve i 3–5 progetti candidati con le loro descrizioni ed emette JSON `{project_id | "new", confidence, reason}`.
5. **Task e azioni**: l'LLM estrae in JSON task impliciti (richieste, scadenze) e azioni rapide (rispondi, inoltra, archivia).
6. **Contatti**: propone di creare i contatti per gli indirizzi sconosciuti che non sono rumore.
7. **Riassunto**: aggiornamento incrementale, calcolato da riassunto precedente + nuova email pulita.
8. Ogni output diventa una `suggestion`. In modalità *pensaci tu*, i suggerimenti sopra soglia vengono applicati e marcati `auto_applied`, e restano annullabili.

Prompt e modelli sono versionati, e il campo `suggestion.model` conserva la traccia. Più avanti i suggerimenti accettati e rifiutati possono servire da few-shot.

### 6.3 Composizione e invio
```
UI: scegli progetto → Crea (o Rispondi da conversazione)
  → mittente = project.outgoing_account (senza eccezioni)
  → B3: scegliendo prima un contatto, si suggeriscono i progetti in cui compare (frequenza + recenza)
  → Invia → activity(kind=send, urgent=checkbox) → il messaggio compare subito nella
     conversazione come "in uscita (in coda)"
Scheduler: ogni N minuti esegue le attività pending; urgent = subito
  → SMTP → il sync importa la copia inviata da All Mail e la riconcilia tramite Message-ID
```

### 6.4 Coda delle attività
```
pending ──(batch tick | esegui ora | urgent)──► running ──► done
   │                                               └──► failed ──(riprova)──► pending
   └──(annulla)──► cancelled
```
- Tipi di attività MVP: `send`, `trash`, `archive`, `set_flags`.
- Nei tipi `send` il payload (bozza) resta modificabile fino all'esecuzione.
- Il tick parte ogni N minuti (N si imposta nelle impostazioni) e all'avvio dell'app.
- Le operazioni locali, come spostare, creare note o riordinare, **non** passano dalla coda: sono immediate e hanno un "annulla" nell'interfaccia.

## 7. Interfaccia (MVP)

```
┌──────────────┬────────────────────────────┬──────────────────────────────┐
│ Da smistare  │  elenco conversazioni      │  conversazione / dettaglio   │
│ Progetti ▸   │  (del contesto scelto)     │  albero email, riassunto,    │
│ Persone ◉◉◉  │                            │  allegati, note, task,       │
│ Task         │                            │  suggerimenti (accetta/scarta)│
│ Attività (3) │                            │                              │
└──────────────┴────────────────────────────┴──────────────────────────────┘
```
- **Vista progetto**: schede Conversazioni, Risorse, Note, Task, Persone.
- **Vista persona/gruppo**: conversazioni trasversali ai progetti, raggruppate per progetto, con il pulsante "Scrivi" che suggerisce il progetto.
- **Spostamenti**: drag & drop o comando "Sposta in…" (con scorciatoia da tastiera).

## 8. Sicurezza

- Il server accetta connessioni solo su `127.0.0.1`. Contro gli attacchi da altri siti verso localhost: controllo dell'header `Host` (DNS rebinding) e header obbligatorio `X-MMW: 1` sulle richieste che modificano stato (un sito esterno non può impostarlo senza un preflight CORS, che il server non concede).
- MVP: le credenziali stanno in `.env.local`, escluso da git. In Electron passano al Keychain di macOS (`safeStorage`).
- L'HTML delle email viene renderizzato in un iframe sandbox. Le immagini remote sono bloccate di default per evitare i tracking pixel.

## 9. Roadmap

| Milestone | Contenuto |
|---|---|
| **M0** | Monorepo, schema DB, configurazione account, connessione all'account Gmail di prova |
| **M1** | Sync (recente + backfill + IDLE), parsing, threading, Da smistare, vista conversazione |
| **M2** | Progetti, spostamenti, composizione da progetto, activity queue, invio SMTP |
| **M3** | Contatti (bolle), vista persona, gruppi manuali, suggerimento progetto per contatto |
| **M4** | Analyzer su Ollama: pulizia, rumore, embedding, suggerimento progetto, task suggeriti, riassunti; coda dei task; *pensaci tu* |
| POST | Annotazioni → note/task, versioni degli allegati, ricerca semantica, *organizza tu*, gruppi suggeriti, bozze di risposta, OAuth, Electron |
| FUT | Calendario/scheduling, sync cloud, mobile |

## 10. Decisioni prese

1. **Effetti sul server**: cestino, archivio e letto/non letto si propagano a Gmail, passando dalla activity queue. I progetti restano sempre locali.
2. **LLM**: si sceglie in configurazione. Default `llama3.1:8b`.
3. **Rumore**: newsletter e notifiche arrivano in Da smistare. Possono essere marcate come rumore (a mano o su suggerimento) e finiscono in un'area "Rumore" separata. Le email marcate come rumore non generano embedding né task.
4. **Intervallo del batch**: si imposta nelle impostazioni dell'app.

## 11. Perché SQLite

È un solo utente, in locale. Il carico tipico sono letture piccole e frequenti dall'interfaccia, più scritture in background a raffica. SQLite è lo standard per questo scenario: l'indice di Apple Mail e la ricerca di Thunderbird usano SQLite.

Accorgimenti:
- **Modalità WAL**: le letture dell'interfaccia non vengono bloccate dalle scritture del sync.
- **Scritture raggruppate in transazioni**: centinaia di messaggi per transazione.
- **Corpi delle email e allegati su disco** (blob store), non dentro il DB. Il DB resta piccolo, nell'ordine delle centinaia di MB.
- Indici sulle query calde: conversazioni per progetto ordinate per data, messaggi per contatto.
- **Lavori pesanti in un worker thread**: import, embedding e analisi non bloccano l'event loop dell'API.

Unico punto da sorvegliare: con `sqlite-vec` la ricerca vettoriale è a forza bruta. Su circa 100k chunk costa qualche centinaio di ms, e si riduce con la quantizzazione int8 o binaria e con un prefiltro per progetto o periodo. Se un giorno non bastasse, l'indice vettoriale è dietro un'interfaccia e si può sostituire, ad esempio con LanceDB, senza toccare il resto. In ogni caso i colli di bottiglia reali sono Ollama (secondi per email) e la rete IMAP, non il DB.

## 12. Autenticazione Gmail

Due assi indipendenti:
- **Credenziale**: app password oppure OAuth2.
- **Protocollo**: IMAP/SMTP oppure Gmail API.

Restiamo su IMAP/SMTP con entrambe le credenziali. In IMAP OAuth si chiama XOAUTH2, quindi l'adapter è unico.

| | App password | OAuth2 (XOAUTH2) |
|---|---|---|
| Setup | Verifica in due passaggi + genera la password: 5 minuti | Progetto Google Cloud, client OAuth "Desktop", schermata di consenso: circa 30 minuti |
| Codice | Nessuno extra | Flusso loopback + PKCE, refresh dei token: circa 1 giorno |
| Sicurezza | Accesso completo alla casella; revoca solo per singola password | Token revocabile; il segreto salvato è un refresh token, non una password |
| Rischi | Gli admin Workspace possono disabilitarle; Google le scoraggia da anni | Scope `https://mail.google.com/` "restricted". In stato *Testing* i refresh token scadono ogni 7 giorni → si pubblica l'app come uso personale non verificato (avviso "app non verificata", limite di 100 utenti) |
| Altri provider | Uguale per IMAP generico | Ogni provider ha il suo OAuth (Microsoft, ecc.) |

**Decisione proposta (ibrida)**:
- **M0–M1**: app password sull'account di prova. Si lavora subito sul cuore del sistema.
- **Prima di collegare l'account vero**: OAuth2 XOAUTH2. L'adapter riceve un `CredentialProvider` con le varianti `password` e `oauth2`.

**Account in uso**:
- *Prova* (@gmail.com): app password.
- *Personale* (@gmail.com): OAuth, con app pubblicata come uso personale non verificato.
- *Lavoro* (Google Workspace): dipende dalle policy dell'amministratore, che può bloccare sia le app password sia le app OAuth di terze parti. L'opzione migliore è un client OAuth di tipo **"Internal"**, creato in un progetto Google Cloud dell'organizzazione: niente verifica, niente scadenza a 7 giorni. In alternativa l'admin può autorizzare esplicitamente il nostro client ID. Va verificato con l'amministratore prima della milestone OAuth.

I dettagli delle policy Google (scadenza dei token, limiti per le app non verificate) vanno ricontrollati sulla documentazione attuale quando si implementa.
