# Documento dei requisiti — my_mail_workflow

Versione 0.2 — 2026-10-07

## 1. Visione

Un client di posta personale **organizzato per progetti e persone**, non per cartelle e account.
Ogni conversazione appartiene a un progetto; un analizzatore AI locale (Ollama) suggerisce dove
smistare la posta, quali task nascono dalle email e mantiene un riassunto di ogni conversazione.
Le operazioni con effetti esterni (invio, modifiche sul server) passano da una coda di attività
eseguita a batch, che lascia il tempo di ripensarci.

## 2. Contesto e vincoli

| Vincolo | Decisione |
|---|---|
| Utenti | Uno solo (uso personale) |
| Piattaforma | Web app in locale → in seguito impacchettata in Electron. Versione mobile futura |
| Provider | Gmail obbligatorio; IMAP/SMTP generico se il costo è basso |
| Dati applicativi | Solo locali (progetti, note, task non vanno sul server di posta). Predisposizione a una sincronizzazione cloud futura per mobile/altre app |
| AI | Solo locale, via Ollama (LLM + embedding) |
| Sviluppo | Su un account Gmail di prova con pochi messaggi |
| Fuori scope v1 | Scheduling/calendario, multiutente, mobile, sync cloud |

## 3. Glossario

- **Account**: casella di posta configurata. Per la posta in ingresso è solo un'etichetta.
- **Inbox unica / Da smistare**: tutte le conversazioni non ancora assegnate a un progetto, indipendentemente dall'account.
- **Progetto**: contenitore *non sovrapposto* di conversazioni, risorse, note e task. Ha un account di uscita.
- **Conversazione**: albero di risposte. Tutte le sue email stanno nello stesso progetto. Contiene allegati versionati, note, task e un riassunto breve.
- **Risorsa**: file o link associato a un progetto (o a una conversazione) non necessariamente arrivato via email.
- **Annotazione**: porzione di testo selezionata in un'email, con etichetta e commento. Può essere promossa a nota o a task.
- **Nota**: testo personale associato a progetto, conversazione o annotazione.
- **Task**: cosa da fare, in una coda ordinabile.
- **Suggerimento**: proposta dell'analizzatore (progetto, conversazione, contatto, gruppo, task, azione, nuovo progetto) che l'utente accetta o scarta.
- **Attività**: operazione con effetti esterni in attesa di esecuzione nella coda batch.

## 4. Requisiti funzionali

Priorità: **MVP** = prima versione utilizzabile; **POST** = successiva; **FUT** = future work.

### A. Account e inbox

| ID | Requisito | Pr. |
|---|---|---|
| RF-A1 | Configurazione di più account. Gmail per primo; adapter IMAP/SMTP generico | MVP |
| RF-A2 | Inbox unica: l'account è un'etichetta visibile ma non usata per navigare | MVP |
| RF-A3 | Import progressivo: prima la posta recente, poi lo storico a ritroso in background | MVP |
| RF-A5 | Area "Rumore": newsletter e notifiche si marcano come rumore (a mano o su suggerimento) e lasciano Da smistare | MVP |
| RF-A4 | Le email inviate da altri client (es. telefono) vengono importate e collegate alle conversazioni | MVP |

### B. Contatti e gruppi

| ID | Requisito | Pr. |
|---|---|---|
| RF-B1 | Contatti visualizzati come bolle (nome + immagine/iniziali). Un contatto può avere più indirizzi | MVP |
| RF-B2 | Clic su contatto/gruppo → elenco conversazioni con quel contatto, trasversale ai progetti | MVP |
| RF-B3 | Scrivendo a un contatto il sistema suggerisce il progetto da cui inviare | MVP |
| RF-B4 | L'analizzatore suggerisce nuovi contatti dagli indirizzi sconosciuti | MVP |
| RF-B5 | Gruppi creati a mano | MVP |
| RF-B6 | Il sistema suggerisce un gruppo quando un insieme di destinatari ricorre spesso | POST |

### C. Progetti

| ID | Requisito | Pr. |
|---|---|---|
| RF-C1 | CRUD progetti (nome, descrizione, account di uscita, archiviazione) | MVP |
| RF-C2 | Ogni progetto ha **un account di uscita**; tutte le email del progetto partono da lì | MVP |
| RF-C3 | Una conversazione appartiene a un solo progetto (o a "Da smistare") | MVP |
| RF-C4 | Non si creano email fuori da un progetto: si sceglie il progetto, poi "Crea" | MVP |
| RF-C5 | Spostabili tra progetti: conversazioni, risorse, note, task. Spostare una singola email la stacca in una nuova conversazione (con conferma) | MVP |
| RF-C6 | Vista progetto: conversazioni, risorse, note, task, contatti coinvolti. Da qui si risponde, si scrive, si allega | MVP |
| RF-C7 | Il contenuto del progetto è contesto per suggerimenti di azioni e risposte | POST |

### D. Conversazioni

| ID | Requisito | Pr. |
|---|---|---|
| RF-D1 | Ricostruzione dell'albero delle risposte | MVP |
| RF-D2 | Una nuova email in una conversazione esistente eredita il progetto della conversazione | MVP |
| RF-D3 | Riassunto breve aggiornato a ogni nuova email | MVP |
| RF-D4 | Repository degli allegati della conversazione | MVP |
| RF-D5 | Versioni degli allegati nella conversazione — v1: stesso nome file; nuova versione solo se cambia il contenuto; storia con data e mittente | ✅ |
| RF-D6 | Versioni — v2: nome simile + stesso tipo ✅; v3: contenuto simile | FUT |

### E. Analizzatore

| ID | Requisito | Pr. |
|---|---|---|
| RF-E1 | Su ogni email nuova suggerisce: progetto (se conversazione nuova), contatti nuovi, task, azioni immediate | MVP |
| RF-E2 | Un task suggerito si promuove a task con un clic | MVP |
| RF-E3 | "Pensaci tu" non è un comando ma l'analizzatore che lavora in background: le azioni suggerite sono già pronte quando l'elemento viene mostrato o si apre il menu contestuale. Nulla viene applicato da solo: sceglie sempre l'utente | MVP |
| RF-E4 | La classificazione della posta in Da smistare avviene in background (anche sullo storico): il progetto suggerito compare sotto la conversazione e nel menu contestuale | MVP |
| RF-E5 | Suggerimento di bozze di risposta usando il contesto del progetto | POST |

### F. Task

| ID | Requisito | Pr. |
|---|---|---|
| RF-F1 | Un task nuovo va in fondo alla coda, salvo che gli si assegni una priorità | MVP |
| RF-F2 | I task sono riordinabili manualmente | MVP |
| RF-F3 | Scadenza opzionale | MVP |
| RF-F4 | Task collegabili a progetto, conversazione, email, annotazione | MVP |
| RF-F6 | I task stanno nei progetti: nella barra del progetto, dopo il titolo, i primi task; un'icona apre a destra il pannello riordinabile dei task del progetto | MVP |
| RF-F5 | Scheduling e calendario | FUT |

### G. Note e annotazioni

| ID | Requisito | Pr. |
|---|---|---|
| RF-G1 | Note personali su progetto e conversazione | MVP |
| RF-G2 | Annotazione: selezione di testo in un'email + etichetta + commento | POST |
| RF-G3 | Un'annotazione si promuove a nota o a task mantenendo il collegamento al testo | POST |

### H. Ricerca

| ID | Requisito | Pr. |
|---|---|---|
| RF-H1 | Ricerca testuale (full-text) | MVP |
| RF-H2 | Embedding di tutte le email (escluse quelle marcate come rumore), chunk senza testo quotato | MVP (interno, per l'analizzatore) |
| RF-H3 | Interrogazione in linguaggio naturale della posta | POST |

### L. Menu contestuale

| ID | Requisito | Pr. |
|---|---|---|
| RF-L1 | Tasto destro su conversazione, messaggio, voce della barra superiore, bolla, file: barra flottante ancorata sopra l'elemento, con prima le azioni suggerite (viola) e poi le principali | MVP |
| RF-L2 | "Altro" (o iniziare a scrivere) apre la palette contestuale: ricerca, gruppi "Suggerite" e "Azioni", scorciatoie, navigazione da tastiera; da tastiera si apre direttamente la palette | MVP |

### I. Coda delle attività

| ID | Requisito | Pr. |
|---|---|---|
| RF-I1 | Le operazioni con effetti esterni (invio, cestino/archivio/flag sul server) entrano in una coda | MVP |
| RF-I2 | Il sistema esegue la coda a batch ogni N minuti (N nelle impostazioni) | MVP |
| RF-I7 | Cestino, archivio e letto/non letto si propagano al server di posta | MVP |
| RF-I3 | Ogni attività si può annullare o modificare finché non è eseguita | MVP |
| RF-I4 | "Urgente": checkbox in composizione, oppure "esegui ora" dalla lista attività | MVP |
| RF-I5 | Le attività fallite restano visibili con l'errore e si possono ritentare | MVP |
| RF-I6 | Le operazioni solo locali (spostamenti tra progetti, note, task) sono immediate, con annulla | MVP |

## 5. Requisiti non funzionali

- **RNF-1 Privacy**: nessun contenuto email lascia la macchina (AI solo via Ollama). Server in ascolto solo su `localhost`.
- **RNF-2 Local-first**: tutto funziona offline sulla posta già scaricata; la coda attende la rete.
- **RNF-3 Predisposizione al sync**: ID globali (ULID), timestamp di modifica e tombstone sulle entità applicative.
- **RNF-4 Scalabilità**: decine di migliaia di email senza degrado dell'interfaccia.
- **RNF-5 Spazio**: stima embedding ~8 KB/email (≈160 MB per 20k email; ≈40 MB con quantizzazione int8). Accettabile.
- **RNF-6 Credenziali**: mai in chiaro nel repository; in Electron nel Keychain di macOS.
- **RNF-7 Estendibilità**: provider di posta e modelli AI dietro interfacce sostituibili.

## 6. Decisioni aperte

Vedi la sezione "Domande aperte" in `02-system-design.md`.
