// Tipi condivisi tra server e web (DTO dell'API).

export type MailProvider = 'gmail' | 'imap';
export type AuthType = 'password' | 'oauth2';

export interface AccountDto {
  id: string;
  name: string;
  email: string;
  provider: MailProvider;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  authType: AuthType;
  /** Riferimento alla credenziale, mai la credenziale stessa ("keychain:<id>"; "env:NOME" solo in sviluppo). */
  credentialRef: string;
  color: string | null;
}

/** Firma riutilizzabile: si definisce nelle impostazioni e si sceglie nel progetto. */
export interface SignatureDto {
  id: string;
  label: string;
  html: string;
  text: string;
}

export interface CreateAccountInput {
  name: string;
  email: string;
  provider: MailProvider;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username?: string;
  /** Va nel Portachiavi di macOS, mai nel database. */
  password?: string;
  /** Solo sviluppo: riferimento già pronto (env:NOME_VARIABILE). */
  credentialRef?: string;
  color?: string | null;
}

export interface MailboxInfo {
  path: string;
  name: string;
  specialUse: string | null;
  messages: number | null;
  unseen: number | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  /** Cartella da sincronizzare: All Mail su Gmail, INBOX altrove. */
  syncMailbox?: string;
  mailboxes?: MailboxInfo[];
  capabilities?: string[];
}

export interface HealthDto {
  ok: boolean;
  db: { ok: boolean; vec: string | null };
  ollama: { ok: boolean; url: string; models: string[]; error?: string };
  config: { llmModel: string; defaultLlmModel: string; embedModel: string; llmAvailable: boolean; embedAvailable: boolean };
}

export interface SettingsDto {
  /** Intervallo del batch della coda attività, in minuti. */
  activityBatchMinutes: number;
  /** Giorni di posta recente importati e analizzati subito. */
  initialSyncDays: number;
  /** Modello di Ollama per assistente e analisi; null = quello predefinito (OLLAMA_LLM_MODEL). */
  llmModel: string | null;
  /** Minuti per cui il modello resta caricato in memoria dopo l'ultima richiesta; -1 = sempre. */
  ollamaKeepAliveMinutes: number;
  /** Analisi in background in pausa (sintesi, classificazione, task, indicizzazione): l'assistente resta attivo. */
  aiPaused: boolean;
  /**
   * Sintesi, classificazione, task e azioni suggerite solo sulla posta degli ultimi N giorni (0 = tutta).
   * La posta più vecchia resta cercabile; la sua sintesi si genera su richiesta.
   */
  aiWindowDays: number;
  /** Smistamento della posta nuova: niente, solo suggerimenti, o automatico quando la regola è affidabile (RF-E6). */
  autoSortMode: 'off' | 'suggest' | 'auto';
  /** Formato con cui nasce una bozza nuova. */
  composeFormat: ComposeFormat;
  /** Carattere e dimensione delle mail HTML. */
  composeFont: ComposeFont;
  composeFontSize: ComposeFontSize;
  /** Nelle risposte si include il messaggio originale (si può cambiare in ogni bozza). */
  replyIncludeQuote: boolean;
}

export type ComposeFormat = 'text' | 'html';
export type ComposeFont = 'sans' | 'serif' | 'mono';
export type ComposeFontSize = 'small' | 'normal' | 'large';

/** CSS dei caratteri delle mail HTML: font comuni, presenti anche sui computer di chi legge. */
export const COMPOSE_FONTS: Record<ComposeFont, { label: string; css: string }> = {
  sans: { label: 'Senza grazie (Arial)', css: 'Arial, Helvetica, sans-serif' },
  serif: { label: 'Con grazie (Georgia)', css: "Georgia, 'Times New Roman', serif" },
  mono: { label: 'A spaziatura fissa (Courier)', css: "'Courier New', Courier, monospace" },
};
export const COMPOSE_FONT_SIZES: Record<ComposeFontSize, { label: string; css: string }> = {
  small: { label: 'Piccolo', css: '13px' },
  normal: { label: 'Normale', css: '15px' },
  large: { label: 'Grande', css: '18px' },
};

export const DEFAULT_SETTINGS: SettingsDto = {
  activityBatchMinutes: 5,
  initialSyncDays: 90,
  llmModel: null,
  ollamaKeepAliveMinutes: 30,
  autoSortMode: 'suggest',
  aiPaused: false,
  aiWindowDays: 90,
  composeFormat: 'html',
  composeFont: 'sans',
  composeFontSize: 'normal',
  replyIncludeQuote: true,
};

// ─── Sync ────────────────────────────────────────────────────────────────────

/** initial = primo import della posta recente; catchup = recupero di ciò che è arrivato mentre l'app era ferma. */
export type SyncPhase = 'stopped' | 'connecting' | 'initial' | 'catchup' | 'backfill' | 'idle' | 'error';

export interface SyncStatusDto {
  accountId: string;
  phase: SyncPhase;
  mailbox: string | null;
  /** Messaggi importati in questa sessione. */
  imported: number;
  /** UID più basso importato: il backfill scende fino a 1. */
  lowestUid: number | null;
  backfillDone: boolean;
  error: string | null;
  updatedAt: number;
}

export type ServerEvent =
  | { type: 'sync'; status: SyncStatusDto }
  | { type: 'conversations'; ids: string[] }
  | { type: 'projects' }
  | { type: 'activities' }
  | { type: 'people' }
  | { type: 'tasks' }
  | { type: 'sharing' };

// ─── Uso su più PC (docs/03-uso-su-piu-pc.md) ────────────────────────────────

/**
 * disabled = nessuna cartella condivisa (si usa come sempre); holder = questo PC ha il database;
 * waiting = in uso altrove (sola lettura); syncing = libero, ma Google Drive non ha ancora scaricato
 * l'ultima versione consegnata.
 */
export type SharingState = 'disabled' | 'holder' | 'waiting' | 'syncing';

export interface SharingLeaseDto {
  holderId: string | null;
  holderName: string | null;
  since: number | null;
  heartbeat: number | null;
  version: number;
  /** Un altro PC chiede il rilascio. */
  releaseRequestedBy: string | null;
}

export interface SharingStatusDto {
  state: SharingState;
  folder: string | null;
  machineId: string;
  machineName: string;
  idleReleaseMinutes: number;
  lease: SharingLeaseDto | null;
  /** Versione dei dati personali importata o consegnata da questo PC. */
  localVersion: number;
  lastDeliveryAt: number | null;
  /** Il PC che ha il database non dà segni da troppo: si può prendere comunque. */
  holderStale: boolean;
  error: string | null;
}

export interface SharingFolderInput {
  folder: string | null;
  /** Copia il contenuto della cartella attuale nella nuova. */
  copy?: boolean;
  /** Secondo PC: la cartella deve già contenere i dati dell'altro PC (non se ne inaugura una vuota). */
  join?: boolean;
}

/** Cosa succede scegliendo una cartella condivisa (per la finestra di conferma). */
export interface SharingFolderPreviewDto {
  /** Percorso completo, come verrà usato. */
  folder: string;
  /** La cartella non esiste ancora e verrà creata. */
  create: boolean;
  /**
   * join: contiene già i dati di un altro PC (quelli di questo PC verranno sostituiti);
   * copy: si copia il contenuto della cartella attuale; new: si scrivono i dati di questo PC.
   */
  mode: 'join' | 'copy' | 'new';
  /** Byte che verranno scritti nella cartella (per join: quelli del file dei dati già presente). */
  bytes: number;
  /** Quanti file (per new: i file caricati da te, oltre al file dei dati). */
  files: number;
  /** Per new: dimensione del solo file dei dati personali. */
  dataBytes: number;
  /** Per join: chi ha consegnato i dati e quale versione. */
  holderName: string | null;
  version: number | null;
  /** Per copy: la cartella attuale (che non viene cancellata). */
  from: string | null;
}

/** Account con o senza password su questo PC (sul secondo PC le password vanno reinserite). */
export interface AccountCredentialDto {
  id: string;
  hasPassword: boolean;
}

// ─── Conversazioni ───────────────────────────────────────────────────────────

export interface PersonRef {
  name: string | null;
  email: string;
}

export interface ConversationListItem {
  id: string;
  subject: string | null;
  /** Staccata a mano da questa conversazione (RF-C5): si può riunire. */
  splitFromId: string | null;
  /** Smistata da sola nel progetto e non ancora aperta (RF-E6). */
  autoSorted: boolean;
  isSpam: boolean;
  /** Chiave d'ordine della lista: ultimo messaggio, o il momento del distacco se più recente. */
  sortAt: number;
  /** Sintesi breve generata dall'LLM (null finché non è pronta). */
  summary: string | null;
  summaryDetailed: string | null;
  snippet: string | null;
  lastMessageAt: number;
  messageCount: number;
  /** Messaggi non letti (in arrivo). */
  unreadCount: number;
  hasAttachments: boolean;
  /** Almeno un messaggio importante. */
  important: boolean;
  /** C'è una bozza salvata per questa conversazione. */
  hasDraft: boolean;
  /** Numero di file distinti (non di invii: le versioni di uno stesso file contano una volta). */
  attachmentCount: number;
  /** Task aperti collegati alla conversazione. */
  taskCount: number;
  noteCount: number;
  resourceCount: number;
  isNoise: boolean;
  projectId: string | null;
  archived: boolean;
  /** Azioni suggerite dall'analizzatore, in attesa (dalla più sicura). */
  suggestions: SuggestionDto[];
  /** Partecipanti esclusi i propri indirizzi. */
  participants: PersonRef[];
  accountIds: string[];
}

export type SuggestionKind = 'project' | 'new_project' | 'conversation' | 'contact' | 'group' | 'task' | 'action' | 'noise';

/** Suggerimento calcolato in background ("pensaci tu"): l'utente lo accetta o lo scarta. */
export interface SuggestionDto {
  id: string;
  kind: SuggestionKind;
  confidence: number | null;
  /** Per project/new_project: { projectId, projectName, reason, signals }. */
  payload: { projectId?: string | null; projectName?: string; reason?: string; [k: string]: unknown };
  createdAt: number;
}

/** Task suggerito dall'assistente in una conversazione del progetto (pannello Task). */
export interface TaskSuggestionDto extends SuggestionDto {
  conversationId: string;
  conversationTitle: string | null;
}

export interface AttachmentDto {
  id: string;
  filename: string | null;
  mime: string | null;
  size: number;
  isInline: boolean;
  /** Versione del file a cui corrisponde questo allegato (se il file ha più versioni nella conversazione). */
  versionNo?: number;
  versionCount?: number;
}

/** Una versione di un file: nasce quando il contenuto cambia. */
export interface FileVersionDto {
  no: number;
  attachmentId: string;
  messageId: string;
  filename: string | null;
  mime: string | null;
  size: number;
  /** Data di ricezione e mittente della prima volta che questo contenuto è arrivato. */
  date: number;
  from: PersonRef | null;
  /** Stesso contenuto rimandato più tardi (non è una nuova versione). */
  resent: { attachmentId: string; messageId: string; filename: string | null; date: number; from: PersonRef | null }[];
}

/** Un file della conversazione con la sua storia (versioni dalla più recente). */
export interface FileDto {
  key: string;
  name: string;
  latest: FileVersionDto;
  versions: FileVersionDto[];
}

export interface MessageDto {
  id: string;
  /** Messaggio a cui risponde (nella stessa conversazione): base dell'albero. */
  parentId: string | null;
  accountId: string;
  direction: 'in' | 'out';
  from: PersonRef | null;
  to: PersonRef[];
  cc: PersonRef[];
  date: number;
  subject: string | null;
  bodyText: string | null;
  bodyTextClean: string | null;
  hasHtml: boolean;
  seen: boolean;
  /** Segnalibro "Importante" (D16). */
  important: boolean;
  /** Solo per i messaggi scritti nell'app. */
  outgoingStatus: 'queued' | 'sent' | 'failed' | null;
  attachments: AttachmentDto[];
}

export interface ConversationDetail {
  id: string;
  subject: string | null;
  projectId: string | null;
  isNoise: boolean;
  archived: boolean;
  summary: string | null;
  summaryDetailed: string | null;
  messages: MessageDto[];
  /** File allegati della conversazione con le loro versioni (esclusi gli inline). */
  files: FileDto[];
  notes: NoteDto[];
  resources: ResourceDto[];
}

export interface NoteDto {
  id: string;
  conversationId: string | null;
  projectId: string | null;
  /** Messaggio da cui è nata la nota. */
  messageId: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface ResourceDto {
  id: string;
  conversationId: string | null;
  projectId: string | null;
  kind: 'file' | 'link';
  title: string;
  url: string | null;
  size: number | null;
  mime: string | null;
  createdAt: number;
}

// ─── Task ────────────────────────────────────────────────────────────────────

export interface TaskDto {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  messageId: string | null;
  /** Oggetto della conversazione collegata, per il contesto. */
  conversationSubject: string | null;
  title: string;
  details: string | null;
  status: 'open' | 'done';
  rank: string;
  /** 1 = in cima alla coda. */
  priority: number | null;
  /** Scadenza facoltativa: data ISO "AAAA-MM-GG". */
  dueDate: string | null;
  completedAt: number | null;
  createdAt: number;
}

export interface TaskInput {
  /** null = Da smistare. */
  projectId: string | null;
  title: string;
  details?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  dueDate?: string | null;
  /** true = in cima alla coda invece che in fondo. */
  top?: boolean;
  /** Brano del messaggio da cui nasce il task (annotazione). */
  quote?: QuoteSelector;
}

// ─── Persone e gruppi ────────────────────────────────────────────────────────

/**
 * Una persona è un contatto confermato (con uno o più indirizzi) oppure un indirizzo
 * visto nelle email e non ancora associato a un contatto.
 * key: "c:<contactId>" oppure "a:<addressId>".
 */
export interface PersonDto {
  key: string;
  contactId: string | null;
  name: string | null;
  emails: string[];
  conversationCount: number;
  lastSeenAt: number | null;
  /** Foto caricata dall'utente (solo contatti confermati). */
  avatarUrl: string | null;
  /** Associato esplicitamente al progetto (solo nelle viste di progetto). */
  member?: boolean;
}

export interface GroupDto {
  id: string;
  name: string;
  members: PersonDto[];
}

export interface PeopleDirectoryDto {
  contacts: PersonDto[];
  /** Indirizzi frequenti non ancora confermati come contatti. */
  suggested: PersonDto[];
  groups: GroupDto[];
  /** Progetti (attivi) nella cui barra compare ogni contatto, direttamente o tramite un gruppo. */
  contactProjects: Record<string, string[]>;
  /** Progetti (attivi) in cui è usato ogni gruppo. */
  groupProjects: Record<string, string[]>;
}

/** Contatti e gruppi inseriti in un progetto: scorciatoie per scrivere. */
export interface ProjectMembersDto {
  contacts: PersonDto[];
  groups: GroupDto[];
}

export interface ContactInput {
  name: string;
  emails: string[];
}

export interface ProjectSuggestion {
  projectId: string;
  name: string;
  conversations: number;
}

export type ConversationView = 'inbox' | 'noise' | 'spam' | 'project' | 'person';

export interface UnreadCountsDto {
  inbox: number;
  noise: number;
  spam: number;
  inboxUnread: number;
  noiseUnread: number;
  /** Messaggi non letti fuori dal rumore (Da smistare + progetti attivi). */
  totalUnread: number;
  /** Task aperti di Da smistare, e quanti sono scaduti. */
  inboxOpenTasks: number;
  inboxOverdueTasks: number;
}

export interface ConversationQuery {
  view: ConversationView;
  projectId?: string;
  /** Filtra le conversazioni in cui compare questa persona (PersonDto.key). */
  person?: string;
  archived?: boolean;
  /** Solo le conversazioni con almeno un messaggio importante (attive e archiviate). */
  important?: boolean;
  /** Solo quelle con messaggi da leggere (gruppo "Da leggere"), oppure tutte le altre. */
  unread?: 'only' | 'exclude';
  /** Solo quelle con data d'ordine da questo momento in poi (insieme a before: un gruppo per data). */
  after?: number;
  before?: number;
}

// ─── Progetti ────────────────────────────────────────────────────────────────

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  outgoingAccountId: string;
  /** Firma delle mail del progetto (null = nessuna). */
  signatureId: string | null;
  color: string | null;
  /** Categoria nella barra laterale (null = "Senza categoria"). */
  categoryId: string | null;
  archived: boolean;
  conversationCount: number;
  /** Conversazioni archiviate del progetto (per la conferma di rimozione). */
  archivedConversationCount: number;
  /** Messaggi non letti nelle conversazioni attive del progetto. */
  unreadCount: number;
  /** Task aperti, e quanti hanno la scadenza già passata. */
  openTaskCount: number;
  overdueTaskCount: number;
  lastMessageAt: number | null;
}

export interface ProjectInput {
  name: string;
  description?: string | null;
  outgoingAccountId: string;
  signatureId?: string | null;
  color?: string | null;
  categoryId?: string | null;
}

/** Categoria della barra dei progetti, nell'ordine scelto dall'utente. */
export interface ProjectCategoryDto {
  id: string;
  name: string;
  collapsed: boolean;
}

/**
 * Disposizione della barra laterale salvata dalla modalità Gestione: ordine delle categorie e, per ogni
 * progetto in ordine, la sua categoria (null = Senza categoria).
 */
export interface ProjectLayoutInput {
  categories: string[];
  projects: { id: string; categoryId: string | null }[];
}

// ─── Coda attività ───────────────────────────────────────────────────────────

export type ActivityKind = 'send' | 'trash' | 'archive' | 'set_flags' | 'auto_sort' | 'spam';
export type ActivityStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ActivityDto {
  id: string;
  kind: ActivityKind;
  accountId: string | null;
  status: ActivityStatus;
  urgent: boolean;
  /** Descrizione leggibile ("Invio: Re: Riunione → mario@x.it"). */
  label: string;
  conversationId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  executedAt: number | null;
}

export interface ActivityQueueDto {
  activities: ActivityDto[];
  /** Prossima esecuzione automatica del batch (ms epoch). */
  nextRunAt: number | null;
}

// ─── Composizione ────────────────────────────────────────────────────────────

export interface OutgoingAttachment {
  blobSha: string;
  filename: string;
  mime: string | null;
}

export interface ComposeInput {
  /** Progetto da cui si scrive: determina l'account mittente. Obbligatorio. */
  projectId: string;
  /** Risposta: messaggio a cui si risponde (la conversazione viene spostata nel progetto). */
  replyToMessageId?: string;
  /** Inoltro: messaggio inoltrato (testo e allegati); nasce una conversazione nuova. */
  forwardMessageId?: string;
  /** Aggiunge in fondo il testo citato del messaggio a cui si risponde. */
  includeQuote?: boolean;
  attachments?: OutgoingAttachment[];
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  urgent?: boolean;
}

// ─── Bozze ───────────────────────────────────────────────────────────────────

export interface DraftAttachment {
  id: string;
  blobSha: string;
  filename: string;
  mime: string | null;
  size: number;
}

export interface DraftDto {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  replyToMessageId: string | null;
  forwardMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Testo semplice; per le bozze HTML è la versione in testo dell'HTML (ricerca, assistente, invio). */
  body: string;
  format: ComposeFormat;
  bodyHtml: string | null;
  includeQuote: boolean;
  attachments: DraftAttachment[];
  updatedAt: number;
}

export type DraftPatch = Partial<Pick<DraftDto, 'projectId' | 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'format' | 'bodyHtml' | 'includeQuote'>>;

// ─── Assistente ──────────────────────────────────────────────────────────────

export interface AssistantMessageDto {
  id: string;
  role: 'user' | 'assistant';
  /** read = risposta sulla conversazione; compose = testo proposto per la bozza. */
  mode: 'read' | 'compose';
  content: string;
  createdAt: number;
}

export interface ReplyIdea {
  title: string;
  description: string;
}

// ─── Ricerca unica (S5) ──────────────────────────────────────────────────────

/** Ambito: tutto, un progetto, oppure le due viste di sistema. */
export type SearchScope = 'all' | 'inbox' | 'news' | `project:${string}`;

interface SearchHitBase {
  conversationId: string | null;
  projectId: string | null;
  isNoise: boolean;
}

export interface SearchConversationHit extends SearchHitBase {
  conversationId: string;
  /** Messaggio più pertinente: è lì che porta il risultato. */
  messageId: string;
  title: string;
  snippet: string;
  participants: PersonRef[];
  date: number;
}

export interface SearchFileHit extends SearchHitBase {
  kind: 'attachment' | 'resource';
  id: string;
  title: string;
  /** Conversazione o progetto di provenienza. */
  context: string;
  size: number | null;
}

export interface SearchItemHit extends SearchHitBase {
  kind: 'task' | 'note';
  id: string;
  title: string;
  snippet: string;
  done: boolean;
}

export interface SearchResults {
  query: string;
  /** Parole cercate, per evidenziarle. */
  terms: string[];
  conversations: SearchConversationHit[];
  files: SearchFileHit[];
  items: SearchItemHit[];
  /** false se la ricerca per significato non era disponibile (Ollama spento): solo parole esatte. */
  semantic: boolean;
}

// ─── Annotazioni ─────────────────────────────────────────────────────────────

/** Brano citato da una selezione: testo esatto più il contesto immediato per ritrovarlo. */
export interface QuoteSelector {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
}

/** Un brano annotato in un messaggio e la nota o il task che vi è nato. */
export interface AnnotationMarkDto {
  annotationId: string;
  exact: string;
  prefix: string | null;
  suffix: string | null;
  kind: 'note' | 'task';
  itemId: string;
  label: string;
  done: boolean;
}

/** Stato della coda dell'analisi in background (barra di stato). */
export interface JobQueueStatusDto {
  paused: boolean;
  /** Lavori in attesa, in totale e per tipo (summarize, classify, embed, …). */
  pending: number;
  byKind: Record<string, number>;
  /** Tipo del lavoro in corso, se ce n'è uno. */
  running: string | null;
}

export type SenderRuleKind = 'news' | 'not_news' | 'spam' | 'not_spam';

/** Regola per mittente come appare nelle impostazioni. */
export interface SenderRuleDto {
  id: string;
  pattern: string;
  kind: SenderRuleKind;
  createdAt: number;
}

/** Esito di "è / non è una News", "è / non è Spam": la regola creata e le altre conversazioni a cui si applicherebbe. */
export interface SenderRuleResultDto {
  ruleId: string;
  /** "x@y.it" oppure "@y.it". */
  pattern: string;
  kind: SenderRuleKind;
  /** Altre conversazioni dello stesso mittente che oggi stanno dalla parte sbagliata. */
  total: number;
  items: { conversationId: string; subject: string | null; from: string; date: number }[];
}

/** Dopo aver spostato una conversazione da Da smistare a un progetto: altre che potrebbero andarci. */
export interface RelatedMoveDto {
  /** Progetto di destinazione (spostamento); null per l'archiviazione. */
  projectId: string | null;
  items: {
    conversationId: string;
    subject: string | null;
    from: string | null;
    date: number;
    /** Perché è proposta: "stesso mittente", "contenuto simile", "suggerita per questo progetto", "archiviazione suggerita". */
    reasons: string[];
  }[];
}

// ─── Gruppi per data della lista ─────────────────────────────────────────────
// Oggi, Ieri, Questa settimana, Questo mese, poi i mesi dell'anno in corso uno per uno, poi gli anni
// interi: ci si ricorda di una mail come "era di settembre" o "era dell'anno scorso".

export interface DateGroup {
  /** Chiave stabile (per ricordare i gruppi aperti): today, yesterday, week, month, m-2026-09, y-2025. */
  key: string;
  label: string;
  /** Intervallo [from, to) sulla data d'ordine della conversazione; to null = nessun limite. */
  from: number;
  to: number | null;
}

/** Un gruppo per data con quante conversazioni contiene (intestazioni dei gruppi chiusi). */
export interface DateGroupCount extends DateGroup {
  count: number;
}

const MONTH_NAMES = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

export function dateGroupOf(ts: number, now: Date = new Date()): DateGroup {
  const day = 86_400_000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - day;
  // La settimana comincia il lunedì.
  const weekStart = today - ((now.getDay() + 6) % 7) * day;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (ts >= today) return { key: 'today', label: 'Oggi', from: today, to: null };
  if (ts >= yesterday) return { key: 'yesterday', label: 'Ieri', from: yesterday, to: today };
  if (ts >= weekStart) return { key: 'week', label: 'Questa settimana', from: weekStart, to: yesterday };
  if (ts >= monthStart) return { key: 'month', label: 'Questo mese', from: monthStart, to: Math.min(weekStart, yesterday) };
  const d = new Date(ts);
  if (d.getFullYear() === now.getFullYear()) {
    const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    return { key: `m-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: MONTH_NAMES[d.getMonth()]!, from, to };
  }
  return { key: `y-${d.getFullYear()}`, label: String(d.getFullYear()), from: new Date(d.getFullYear(), 0, 1).getTime(), to: new Date(d.getFullYear() + 1, 0, 1).getTime() };
}
