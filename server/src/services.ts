// Composizione dei servizi applicativi (usata dal server e dai test).
import type Database from 'better-sqlite3';
import type { AccountDto } from '@mmw/shared';
import type { Db } from './db/client.ts';
import { BlobStore } from './store/blobs.ts';
import { SettingsService } from './settings/service.ts';
import { AccountService } from './accounts/service.ts';
import { SyncManager } from './sync/manager.ts';
import { ActivityService } from './activities/service.ts';
import { ActivityRunner } from './activities/runner.ts';
import { MailActions } from './actions/mail-actions.ts';
import { createProvider } from './mail/factory.ts';
import { sendViaSmtp, type SmtpSender } from './mail/smtp.ts';
import type { MailProviderClient } from './mail/provider.ts';

export interface ServiceOverrides {
  createProvider?: (account: AccountDto) => MailProviderClient;
  sendSmtp?: SmtpSender;
}

export function buildServices(db: Db, sqlite: Database.Database, blobDir: string, o: ServiceOverrides = {}) {
  const blobs = new BlobStore(db, blobDir);
  const settings = new SettingsService(db);
  const accounts = new AccountService(db);
  const providerFactory = o.createProvider ?? createProvider;
  const sync = new SyncManager({ db, sqlite, blobs }, () => settings.get().initialSyncDays, providerFactory);
  const activities = new ActivityService(db, sqlite);
  const runner = new ActivityRunner({
    db,
    blobs,
    activities,
    getAccount: (id) => accounts.get(id),
    createProvider: providerFactory,
    sendSmtp: o.sendSmtp ?? sendViaSmtp,
    batchMinutes: () => settings.get().activityBatchMinutes,
  });
  const actions = new MailActions({ db, sqlite, activities, runner, getAccount: (id) => accounts.get(id) });
  return { db, sqlite, blobs, settings, accounts, sync, activities, runner, actions };
}
