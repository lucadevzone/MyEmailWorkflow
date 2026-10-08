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
  /** Livello di autonomia dell'analizzatore. */
  autonomy: 'suggest' | 'auto';
  /** Soglia di confidenza per l'applicazione automatica in modalità "auto". */
  autoApplyThreshold: number;
}

export const DEFAULT_SETTINGS: SettingsDto = {
  activityBatchMinutes: 5,
  initialSyncDays: 90,
  autonomy: 'suggest',
  autoApplyThreshold: 0.85,
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
  | { type: 'people' };

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
  /** Numero di file distinti (non di invii: le versioni di uno stesso file contano una volta). */
  attachmentCount: number;
  noteCount: number;
  resourceCount: number;
  isNoise: boolean;
  projectId: string | null;
  archived: boolean;
  /** Partecipanti esclusi i propri indirizzi. */
  participants: PersonRef[];
  accountIds: string[];
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

export interface ComposeInput {
  /** Progetto da cui si scrive: determina l'account mittente. Obbligatorio. */
  projectId: string;
  /** Risposta: messaggio a cui si risponde (la conversazione viene spostata nel progetto). */
  replyToMessageId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  urgent?: boolean;
}
