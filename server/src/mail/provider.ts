// Adapter verso il server di posta. Un'unica implementazione IMAP/SMTP copre Gmail
// (con le estensioni X-GM-*) e i provider IMAP generici. Vedi docs/02-system-design.md §3.
//
// M0: connessione e ispezione delle cartelle. Fetch, watch, flag e invio arrivano con M1–M2.

import type { MailboxInfo } from '@mmw/shared';

export interface MailProviderClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  capabilities(): string[];
  listMailboxes(): Promise<MailboxInfo[]>;
  /** Cartella da sincronizzare: All Mail su Gmail (contiene anche le inviate), altrimenti INBOX. */
  syncMailbox(): Promise<string>;
}
