# Uso alternato su più PC — progetto

Versione 0.1 — 2026-10-14 · stato: **da approvare**

## 1. Obiettivo e vincoli

- Lo stesso utente usa l'app su due (o più) Mac, alternandoli; l'app può restare aperta su entrambi.
- Su internet deve viaggiare **il meno possibile**. Il canale di scambio è una cartella di **Google Drive** (Google Drive per desktop), che non sincronizza le parti cambiate di un file: ogni file modificato viene ricaricato per intero.
- Un solo PC alla volta scrive (semaforo); l'altro aspetta e può solo consultare.
- La posta sta già su Gmail: ogni PC la importa da sé e non viaggia nel cloud.

## 2. Idea: due tipi di dati

| | Cosa | Dove | Viaggia? |
|---|---|---|---|
| **Archivio della posta** | messaggi, conversazioni come struttura, allegati di posta, indirizzi, indice di ricerca e vettori, stato della sincronizzazione, coda dei lavori, suggerimenti dell'assistente | database locale di ogni PC (`data/`) | **no**: si ricostruisce da Gmail |
| **Dati personali** | progetti, categorie, firme, regole, contatti e gruppi, in quale progetto sta ogni conversazione, archiviate/News/Spam decisi da te, conversazioni staccate e unite, task, note, annotazioni, bozze, chat con l'assistente, coda delle attività (invii!), sintesi, impostazioni comuni | stesso database locale, **più una copia di scambio** nella cartella condivisa | **sì**, pochi MB |
| **File caricati da te** | risorse, foto dei contatti | cartella condivisa `files/` (un file per contenuto, mai modificato) | sì, solo i nuovi |

Lo stato di letto/da leggere e di importante non serve portarlo: viaggia già con Gmail (letto, stella).

Il database locale resta **uno solo, come oggi**: le query dell'app non cambiano. Cambia solo che, quando un PC consegna, esporta i dati personali in un piccolo file; quando l'altro prende, li importa e li riapplica alla propria copia della posta.

## 3. Identità comuni tra i PC

Il problema: oggi ogni PC dà ai messaggi e alle conversazioni codici interni propri. Per riapplicare "questa conversazione sta nel progetto X" o "questo task nasce da quel messaggio" sull'altro PC servono identità valide su entrambi.

- **Messaggio**: chiave stabile = account + identificativo Gmail del messaggio (`X-GM-MSGID`); per IMAP generico, il `Message-ID`. Nel file di scambio i riferimenti ai messaggi (task, note, annotazioni, bozze) usano questa chiave e all'import vengono tradotti nei codici locali.
- **Conversazione**: il codice della conversazione diventa **comune**. Il file di scambio contiene la mappa "messaggio → conversazione" (per tutti i messaggi, circa 62.000 righe, 1-2 MB compressi). All'import il PC adotta quei codici: raggruppa i propri messaggi come indicato dalla mappa, così unioni e distacchi fatti sull'altro PC valgono anche qui, e i task restano agganciati alla conversazione giusta.
- **Posta non ancora importata** sul PC che prende (per esempio la prima volta, o dopo giorni): la mappa resta conservata in locale, e quando il messaggio arriva da Gmail finisce subito nella conversazione e nel progetto giusti.
- **Progetti, task, note, contatti…** hanno già codici unici (ULID) creati su un PC e conservati: viaggiano così come sono.

## 4. La cartella condivisa

```
Google Drive/My Drive/MyEmailWorkflow/
  semaforo.json          chi ha il database, segnale di vita, versione corrente
  personale-<versione>.sqlite.gz   dati personali alla versione indicata (si tengono le ultime 3)
  files/<sha>            file caricati da te (risorse, foto)
```

`semaforo.json`:
```json
{ "holder": "MacBook-ufficio", "since": 1791963000000, "heartbeat": 1791964200000,
  "version": 42, "file": "personale-42.sqlite.gz", "sha256": "…", "size": 1830211,
  "release": null }
```
`release` serve all'altro PC per chiedere il rilascio ("MacBook-casa chiede il database").

## 5. Passaggio del testimone

**Rilascio** (alla chiusura dell'app, con *Rilascia* nel pannello Stato, dopo N minuti senza uso, o su richiesta dell'altro PC):
1. ferma posta, analisi e coda attività; completa le scritture in corso;
2. esporta i dati personali → `personale-<v+1>.sqlite.gz` (scrittura su un file temporaneo e poi rinomina, così Drive non copia mai un file a metà);
3. aggiorna il semaforo: `holder: null`, `version: v+1`, impronta e dimensione;
4. passa in **sola lettura**.

**Presa** (pulsante *Usa qui*, oppure da sola se l'app è in primo piano, il semaforo è libero e la versione è più nuova di quella locale):
1. legge il semaforo; se la versione è più nuova di quella importata, aspetta che Drive abbia scaricato il file giusto (dimensione e impronta coincidono);
2. scrive nel semaforo `holder: <questo PC>`, poi lo rilegge dopo qualche secondo per assicurarsi di averlo preso davvero (Drive non è istantaneo);
3. importa i dati personali (sostituisce quelli locali, adotta la mappa delle conversazioni, traduce i riferimenti ai messaggi);
4. riavvia la posta (recupera quella arrivata nel frattempo), l'analisi e la coda attività.

**Mentre lavora**, il PC che ha il database aggiorna il segnale di vita ogni 30 s e controlla se l'altro chiede il rilascio.

**PC spento all'improvviso** (batteria, crash): il segnale di vita invecchia. Dopo 5 minuti l'altro PC propone *Usa qui comunque*: si riparte dall'ultima versione consegnata; quello che il PC spento non aveva consegnato va perso. Per ridurre la perdita, il PC attivo **consegna anche ogni 10 minuti** se ci sono state modifiche (pochi MB, senza rilasciare il semaforo).

## 6. Il PC in attesa

- Database locale **in sola lettura**: si può consultare la posta e i progetti com'erano all'ultima presa; ogni modifica è bloccata.
- Fascia in alto: *Il database è in uso su MacBook-ufficio · ultimo segnale 20 s fa* — **Usa qui** (chiede il rilascio e aspetta) · **Usa qui comunque** (solo se il segnale di vita è vecchio).
- Niente sincronizzazione della posta, niente analisi, niente invii.

## 7. Impostazioni

Comuni (viaggiano): tutto ciò che oggi sta in Impostazioni tranne quanto sotto.
Solo di questo PC: nome del PC, cartella condivisa, modello di Ollama e permanenza in memoria, pausa dell'analisi, minuti di inattività prima del rilascio.

**Account**: viaggiano senza password. Sul secondo PC, alla prima presa, l'app chiede la password per le app di Gmail e la mette nel Portachiavi di quel Mac.

## 8. Primo avvio sul secondo PC

Procedura di benvenuto → *Ho già l'app su un altro PC* → scelta della cartella condivisa → presa del semaforo → import dei dati personali → password degli account → importazione della posta da Gmail (prima la più recente). Progetti, task e regole sono subito visibili; le conversazioni compaiono man mano che la posta arriva, già nel progetto giusto.

## 9. Quanto viaggia

| | Dimensione indicativa |
|---|---|
| Dati personali (oggi: 41.972 conversazioni, 430 nei progetti, pochi task) | 1-3 MB compressi per consegna |
| `semaforo.json` | < 1 KB, ogni 30 s mentre si lavora |
| File caricati | solo quelli nuovi |
| Posta e allegati di posta | 0 (da Gmail) |

## 10. Cosa non viaggia e si rifà su ogni PC

Indice di ricerca e vettori (indicizzazione locale, veloce), classificazioni e suggerimenti dell'assistente in attesa (solo posta recente, finestra di 90 giorni). Le **sintesi** invece viaggiano, così l'altro PC non le rigenera.

## 11. Fasi di realizzazione

1. **Identità e mappa**: chiave stabile dei messaggi, esportazione/importazione dei dati personali in un file, con test di andata e ritorno su due database.
2. **Semaforo e modalità attesa**: cartella condivisa nelle impostazioni, semaforo con segnale di vita, sola lettura, fascia e pulsanti, rilascio alla chiusura/inattività/richiesta, consegna periodica.
3. **Posta che arriva dopo l'import**: aggancio dei messaggi alla mappa durante l'importazione da Gmail.
4. **File condivisi**: risorse e foto nella cartella `files/`.
5. **Secondo PC da zero**: procedura di benvenuto "Ho già l'app su un altro PC", password degli account.

## 12. Rischi e limiti

- Drive non è istantaneo: il passaggio richiede da qualche secondo a un minuto, il tempo di caricare e scaricare pochi MB.
- Presa contemporanea dai due PC (finestra di pochi secondi): la verifica dopo la scrittura del semaforo la rende molto improbabile; nel caso peggiore uno dei due torna in attesa.
- Lavoro non consegnato su un PC spento di colpo: al massimo gli ultimi 10 minuti.
- La prima importazione della posta sul secondo PC richiede ore (come al primo avvio); l'analisi con l'IA riguarda solo la posta recente.
