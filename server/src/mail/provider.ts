// Adapter verso il server di posta. Un'unica implementazione IMAP/SMTP copre Gmail
// (con le estensioni X-GM-*) e i provider IMAP generici. Vedi docs/02-system-design.md §3.
//
// Flag, cestino, archivio e invio arrivano con M2 (coda attività).

import type { MailboxInfo } from '@mmw/shared';

export interface MailboxState {
  path: string;
  uidValidity: string;
  uidNext: number;
  highestModseq: string | null;
  exists: number;
}

export interface FetchedMessage {
  uid: number;
  source: Buffer;
  flags: string[];
  labels: string[];
  gmMsgid: string | null;
  gmThreadId: string | null;
  internalDate: Date | null;
}

export interface FlagUpdate {
  uid: number;
  flags: string[];
  /** null = non fornite (es. evento IDLE): restano quelle salvate. */
  labels: string[] | null;
  gmMsgid: string | null;
}

export interface MailboxEvents {
  onNewMessages(): void;
  onFlags(update: FlagUpdate): void;
  onExpunge(): void;
  onClose(): void;
  onError(err: Error): void;
}

export interface MailProviderClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  capabilities(): string[];
  listMailboxes(): Promise<MailboxInfo[]>;
  /** Cartella da sincronizzare: All Mail su Gmail (contiene anche le inviate), altrimenti INBOX. */
  syncMailbox(): Promise<string>;
  openMailbox(path: string): Promise<MailboxState>;
  searchUidsSince(since: Date): Promise<number[]>;
  /** UID esistenti in un range ("1:500"): i UID di Gmail sono sparsi, non si può contare per intervalli. */
  searchUidRange(range: string): Promise<number[]>;
  /** Accetta un elenco di UID o un range IMAP ("100:200"). */
  fetchUids(uids: number[] | string): AsyncIterable<FetchedMessage>;
  fetchFlagsChangedSince(modseq: string): Promise<FlagUpdate[]>;
  on(events: MailboxEvents): () => void;
}
