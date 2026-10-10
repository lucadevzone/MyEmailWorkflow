import type { AccountDto, SyncStatusDto } from '@mmw/shared';
import type { IngestContext } from '../ingest/ingest.ts';
import { createProvider } from '../mail/factory.ts';
import type { MailProviderClient } from '../mail/provider.ts';
import { AccountSync } from './account-sync.ts';

export class SyncManager {
  private syncs = new Map<string, AccountSync>();

  constructor(
    private ctx: IngestContext,
    private initialSyncDays: () => number,
    private providerFactory: (a: AccountDto) => MailProviderClient = createProvider,
  ) {}

  start(account: AccountDto) {
    if (this.syncs.has(account.id)) return;
    const sync = new AccountSync(account, {
      ctx: this.ctx,
      createProvider: this.providerFactory,
      initialSyncDays: this.initialSyncDays,
    });
    this.syncs.set(account.id, sync);
    void sync.start();
  }

  async stop(accountId: string) {
    const sync = this.syncs.get(accountId);
    if (!sync) return;
    this.syncs.delete(accountId);
    await sync.stop();
  }

  async stopAll() {
    await Promise.all([...this.syncs.keys()].map((id) => this.stop(id)));
  }

  checkNow() {
    for (const s of this.syncs.values()) s.checkNow();
  }

  statuses(): SyncStatusDto[] {
    return [...this.syncs.values()].map((s) => s.getStatus());
  }
}
