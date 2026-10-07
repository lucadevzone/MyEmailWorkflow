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
