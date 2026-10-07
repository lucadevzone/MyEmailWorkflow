import { ImapFlow } from 'imapflow';
import type { MailboxInfo } from '@mmw/shared';
import type { MailProviderClient } from './provider.ts';
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
}
