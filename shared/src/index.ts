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
  | { type: 'conversations'; ids: string[] };

// ─── Conversazioni ───────────────────────────────────────────────────────────

export interface PersonRef {
  name: string | null;
  email: string;
}

export interface ConversationListItem {
  id: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isNoise: boolean;
  projectId: string | null;
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
}

export interface MessageDto {
  id: string;
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
  attachments: AttachmentDto[];
}

export interface ConversationDetail {
  id: string;
  subject: string | null;
  projectId: string | null;
  isNoise: boolean;
  summary: string | null;
  messages: MessageDto[];
}

export type ConversationView = 'inbox' | 'noise';
