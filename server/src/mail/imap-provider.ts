import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { MailboxInfo } from '@mmw/shared';
import type { MailProviderClient, MailboxState, FetchedMessage, FlagUpdate, MailboxEvents } from './provider.ts';
import type { ImapAuth } from './credentials.ts';

export interface ImapConnectionOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: ImapAuth;
}

export class ImapProvider implements MailProviderClient {
  private client: ImapFlow;

  constructor(opts: ImapConnectionOptions) {
    this.client = new ImapFlow({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: opts.auth,
      logger: false,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    if (this.client.usable) await this.client.logout();
    else this.client.close();
  }

  capabilities(): string[] {
    return [...this.client.capabilities.keys()];
  }

  isGmail(): boolean {
    return this.client.capabilities.has('X-GM-EXT-1');
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    const list = await this.client.list({ statusQuery: { messages: true, unseen: true } });
    return list
      .filter((m) => !m.flags.has('\\Noselect'))
      .map((m) => ({
        path: m.path,
        name: m.name,
        specialUse: m.specialUse ?? null,
        messages: m.status?.messages ?? null,
        unseen: m.status?.unseen ?? null,
      }));
  }

  async syncMailbox(): Promise<string> {
    if (this.isGmail()) {
      const list = await this.client.list();
      // Il nome visibile di All Mail dipende dalla lingua dell'account ("Tutti i messaggi"):
      // si individua tramite lo special-use, non per nome.
      const all = list.find((m) => m.specialUse === '\\All');
      if (all) return all.path;
    }
    return 'INBOX';
  }

  async openMailbox(path: string): Promise<MailboxState> {
    const mb = await this.client.mailboxOpen(path);
    return {
      path: mb.path,
      uidValidity: mb.uidValidity.toString(),
      uidNext: mb.uidNext,
      highestModseq: mb.highestModseq != null ? mb.highestModseq.toString() : null,
      exists: mb.exists,
    };
  }

  async searchUidsSince(since: Date): Promise<number[]> {
    const res = await this.client.search({ since }, { uid: true });
    return (res || []).sort((a, b) => a - b);
  }

  async searchUidRange(range: string): Promise<number[]> {
    const res = await this.client.search({ uid: range }, { uid: true });
    return (res || []).sort((a, b) => a - b);
  }

  async *fetchUids(uids: number[] | string): AsyncIterable<FetchedMessage> {
    const range = typeof uids === 'string' ? uids : uids.join(',');
    if (!range) return;
    for await (const m of this.client.fetch(
      range,
      { uid: true, source: true, flags: true, labels: true, threadId: true, internalDate: true },
      { uid: true },
    )) {
      if (!m.source) continue;
      yield toFetched(m);
    }
  }

  async fetchFlagsChangedSince(modseq: string): Promise<FlagUpdate[]> {
    const out: FlagUpdate[] = [];
    for await (const m of this.client.fetch(
      '1:*',
      { uid: true, flags: true, labels: true },
      { uid: true, changedSince: BigInt(modseq) },
    )) {
      out.push({ uid: m.uid, flags: [...(m.flags ?? [])], labels: [...(m.labels ?? [])], gmMsgid: m.emailId ?? null });
    }
    return out;
  }

  private async withMailbox<T>(mailbox: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  private async specialFolder(use: string): Promise<string | undefined> {
    return (await this.client.list()).find((m) => m.specialUse === use)?.path;
  }

  async addFlags(mailbox: string, uids: number[], flags: string[]): Promise<void> {
    if (!uids.length) return;
    await this.withMailbox(mailbox, () => this.client.messageFlagsAdd(uids, flags, { uid: true })).then(() => {});
  }

  async removeFlags(mailbox: string, uids: number[], flags: string[]): Promise<void> {
    if (!uids.length) return;
    await this.withMailbox(mailbox, () => this.client.messageFlagsRemove(uids, flags, { uid: true })).then(() => {});
  }

  async moveToTrash(mailbox: string, uids: number[]): Promise<void> {
    if (!uids.length) return;
    const trash = await this.specialFolder('\\Trash');
    if (!trash) throw new Error('Cartella Cestino non trovata sul server');
    await this.withMailbox(mailbox, () => this.client.messageMove(uids, trash, { uid: true }));
  }

  async archive(mailbox: string, uids: number[]): Promise<void> {
    if (!uids.length) return;
    if (this.isGmail()) {
      await this.withMailbox(mailbox, () =>
        this.client.messageFlagsRemove(uids, ['\\Inbox'], { uid: true, useLabels: true }),
      );
      return;
    }
    const archive = await this.specialFolder('\\Archive');
    if (!archive) throw new Error('Cartella Archivio non trovata sul server');
    await this.withMailbox(mailbox, () => this.client.messageMove(uids, archive, { uid: true }));
  }

  async appendToSent(raw: Buffer): Promise<void> {
    const sent = await this.specialFolder('\\Sent');
    if (!sent) throw new Error('Cartella Inviati non trovata sul server');
    await this.client.append(sent, raw, ['\\Seen']);
  }

  on(events: MailboxEvents): () => void {
    const exists = () => events.onNewMessages();
    const flags = (e: { uid?: number; flags?: Set<string> }) => {
      if (e.uid != null) events.onFlags({ uid: e.uid, flags: [...(e.flags ?? [])], labels: null, gmMsgid: null });
    };
    const expunge = () => events.onExpunge();
    const close = () => events.onClose();
    const error = (err: Error) => events.onError(err);
    this.client.on('exists', exists);
    this.client.on('flags', flags);
    this.client.on('expunge', expunge);
    this.client.on('close', close);
    this.client.on('error', error);
    return () => {
      this.client.off('exists', exists);
      this.client.off('flags', flags);
      this.client.off('expunge', expunge);
      this.client.off('close', close);
      this.client.off('error', error);
    };
  }
}

function toFetched(m: FetchMessageObject): FetchedMessage {
  return {
    uid: m.uid,
    source: m.source!,
    flags: [...(m.flags ?? [])],
    labels: [...(m.labels ?? [])],
    gmMsgid: m.emailId ?? null,
    gmThreadId: m.threadId ?? null,
    internalDate: m.internalDate ? new Date(m.internalDate) : null,
  };
}
