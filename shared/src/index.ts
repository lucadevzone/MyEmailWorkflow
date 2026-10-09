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
  /** Riferimento alla credenziale, mai la credenziale stessa (es. "env:MMW_TEST_APP_PASSWORD"). */
  credentialRef: string;
  color: string | null;
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
  credentialRef: string;
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
  config: { llmModel: string; embedModel: string; llmAvailable: boolean; embedAvailable: boolean };
}

export interface SettingsDto {
  /** Intervallo del batch della coda attività, in minuti. */
  activityBatchMinutes: number;
  /** Giorni di posta recente importati e analizzati subito. */
  initialSyncDays: number;
}

export const DEFAULT_SETTINGS: SettingsDto = {
  activityBatchMinutes: 5,
  initialSyncDays: 90,
};

// ─── Sync ────────────────────────────────────────────────────────────────────

export type SyncPhase = 'stopped' | 'connecting' | 'initial' | 'backfill' | 'idle' | 'error';

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
  | { type: 'tasks' };

// ─── Conversazioni ───────────────────────────────────────────────────────────

export interface PersonRef {
  name: string | null;
  email: string;
}

export interface ConversationListItem {
  id: string;
  subject: string | null;
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
  resent: { attachmentId: string; messageId: string; date: number; from: PersonRef | null }[];
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
  projectId: string;
  title: string;
  details?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  dueDate?: string | null;
  /** true = in cima alla coda invece che in fondo. */
  top?: boolean;
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

export type ConversationView = 'inbox' | 'noise' | 'project' | 'person';

export interface UnreadCountsDto {
  inbox: number;
  noise: number;
  inboxUnread: number;
  noiseUnread: number;
  /** Messaggi non letti fuori dal rumore (Da smistare + progetti attivi). */
  totalUnread: number;
}

export interface ConversationQuery {
  view: ConversationView;
  projectId?: string;
  /** Filtra le conversazioni in cui compare questa persona (PersonDto.key). */
  person?: string;
  archived?: boolean;
  before?: number;
}

// ─── Progetti ────────────────────────────────────────────────────────────────

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  outgoingAccountId: string;
  color: string | null;
  archived: boolean;
  conversationCount: number;
  /** Messaggi non letti nelle conversazioni attive del progetto. */
  unreadCount: number;
  lastMessageAt: number | null;
}

export interface ProjectInput {
  name: string;
  description?: string | null;
  outgoingAccountId: string;
  color?: string | null;
}

// ─── Coda attività ───────────────────────────────────────────────────────────

export type ActivityKind = 'send' | 'trash' | 'archive' | 'set_flags';
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
  body: string;
  includeQuote: boolean;
  attachments: DraftAttachment[];
  updatedAt: number;
}

export type DraftPatch = Partial<Pick<DraftDto, 'projectId' | 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'includeQuote'>>;

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
