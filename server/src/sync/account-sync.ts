// Sincronizzazione di un account. Vedi docs/02-system-design.md §4.
//
// Una sessione = una connessione IMAP sulla cartella di sync (All Mail su Gmail):
//   1. primo avvio: importa la posta degli ultimi N giorni;
//      avvii successivi: messaggi nuovi (UID > lastUid) + flag cambiati (CONDSTORE).
//   2. backfill: scende verso i UID più vecchi a blocchi, con priorità più bassa
//      dei messaggi nuovi (tra un blocco e l'altro si controlla se è arrivata posta).
//   3. idle: IMAP IDLE; gli eventi "exists" e "flags" risvegliano il ciclo.
// In caso di errore o disconnessione si riconnette con backoff esponenziale.

import { and, eq } from 'drizzle-orm';
import type { AccountDto, SyncPhase, SyncStatusDto } from '@mmw/shared';
import { syncState, messages } from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { ingestMessage, updateFlags, type IngestContext } from '../ingest/ingest.ts';
import type { FetchedMessage, FlagUpdate, MailProviderClient, MailboxState } from '../mail/provider.ts';
import { describeImapError } from '../accounts/service.ts';

const BACKFILL_BATCH = 50;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface AccountSyncDeps {
  ctx: IngestContext;
  createProvider: (account: AccountDto) => MailProviderClient;
  initialSyncDays: () => number;
}

type SyncRow = typeof syncState.$inferSelect;

export class AccountSync {
  private stopped = false;
  private provider: MailProviderClient | null = null;
  private wake: (() => void) | null = null;
  private pendingNew = false;
  private closed = false;
  private row!: SyncRow;
  private status: SyncStatusDto;
  private touched = new Set<string>();

  constructor(private account: AccountDto, private deps: AccountSyncDeps) {
    this.status = {
      accountId: account.id,
      phase: 'stopped',
      mailbox: null,
      imported: 0,
      lowestUid: null,
      backfillDone: false,
      error: null,
      updatedAt: now(),
    };
  }

  getStatus(): SyncStatusDto {
    return this.status;
  }

  start(): Promise<void> {
    return this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.provider?.close().catch(() => {});
    this.setPhase('stopped');
  }

  // ─── Ciclo principale ──────────────────────────────────────────────────────

  private async run() {
    let backoff = 5_000;
    while (!this.stopped) {
      try {
        await this.session();
        backoff = 5_000;
      } catch (err) {
        if (this.stopped) break;
        this.setPhase('error', describeImapError(err));
      }
      if (this.stopped) break;
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  private async session() {
    this.closed = false;
    this.setPhase('connecting');
    const provider = this.deps.createProvider(this.account);
    this.provider = provider;
    await provider.connect();
    const unsubscribe = provider.on({
      onNewMessages: () => {
        this.pendingNew = true;
        this.wake?.();
      },
      onFlags: (u) => this.applyFlags([u]),
      onExpunge: () => {
        // M1: le cancellazioni lato server non vengono ancora riflesse (arriva con la coda attività).
      },
      onClose: () => {
        this.closed = true;
        this.wake?.();
      },
      onError: () => {},
    });

    try {
      const path = await provider.syncMailbox();
      const mb = await provider.openMailbox(path);
      this.status.mailbox = path;
      this.row = this.loadRow(path, mb);

      if (this.row.lastUid == null) await this.initialImport(provider, mb);
      else await this.catchUp(provider, mb);

      while (!this.stopped && !this.closed) {
        if (this.pendingNew) {
          this.pendingNew = false;
          await this.fetchNew(provider);
        } else if (!this.row.backfillDone) {
          this.setPhase('backfill');
          await this.backfillBatch(provider);
        } else {
          this.setPhase('idle');
          await this.waitForWake();
        }
      }
    } finally {
      unsubscribe();
      await provider.close().catch(() => {});
      this.provider = null;
    }
    if (this.closed && !this.stopped) throw new Error('Connessione chiusa dal server');
  }

  // ─── Fasi ──────────────────────────────────────────────────────────────────

  private async initialImport(provider: MailProviderClient, mb: MailboxState) {
    this.setPhase('initial');
    const since = new Date(Date.now() - this.deps.initialSyncDays() * 86_400_000);
    const uids = await provider.searchUidsSince(since);
    // Prima i più recenti: l'utente vede subito la posta di oggi.
    for (let i = uids.length; i > 0; i -= BACKFILL_BATCH) {
      await this.ingestAll(provider.fetchUids(uids.slice(Math.max(0, i - BACKFILL_BATCH), i)));
      this.flushEvents();
    }
    this.saveRow({
      lastUid: mb.uidNext - 1,
      lowestUid: uids[0] ?? mb.uidNext,
      highestModseq: mb.highestModseq,
      backfillDone: (uids[0] ?? mb.uidNext) <= 1,
    });
  }

  private async catchUp(provider: MailProviderClient, mb: MailboxState) {
    this.setPhase('initial');
    await this.fetchNew(provider);
    if (this.row.highestModseq && mb.highestModseq && this.row.highestModseq !== mb.highestModseq) {
      this.applyFlags(await provider.fetchFlagsChangedSince(this.row.highestModseq));
    }
    this.saveRow({ highestModseq: mb.highestModseq });
  }

  private async fetchNew(provider: MailProviderClient) {
    const lastUid = this.row.lastUid ?? 0;
    let maxUid = lastUid;
    // "N:*" restituisce sempre l'ultimo messaggio, anche se ha UID < N: si filtra.
    await this.ingestAll(provider.fetchUids(`${lastUid + 1}:*`), (m) => {
      if (m.uid <= lastUid) return false;
      maxUid = Math.max(maxUid, m.uid);
      return true;
    });
    if (maxUid > lastUid) this.saveRow({ lastUid: maxUid });
    this.flushEvents();
  }

  private async backfillBatch(provider: MailProviderClient) {
    const lowest = this.row.lowestUid ?? 1;
    if (lowest <= 1) {
      this.saveRow({ backfillDone: true });
      return;
    }
    const older = await provider.searchUidRange(`1:${lowest - 1}`);
    if (older.length === 0) {
      this.saveRow({ lowestUid: 1, backfillDone: true });
      return;
    }
    const batch = older.slice(-BACKFILL_BATCH);
    await this.ingestAll(provider.fetchUids(batch));
    const newLowest = batch[0]!;
    this.saveRow({ lowestUid: newLowest, backfillDone: older.length <= BACKFILL_BATCH });
    this.flushEvents();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async ingestAll(source: AsyncIterable<FetchedMessage>, filter?: (m: FetchedMessage) => boolean) {
    for await (const m of source) {
      if (this.stopped) return;
      if (filter && !filter(m)) continue;
      const res = await ingestMessage(this.deps.ctx, this.account, { ...m, mailbox: this.status.mailbox });
      this.touched.add(res.conversationId);
      if (res.created) this.status.imported++;
    }
  }

  private applyFlags(updates: FlagUpdate[]) {
    const { db } = this.deps.ctx;
    for (const u of updates) {
      const msg = db
        .select({ id: messages.id, conversationId: messages.conversationId, labels: messages.labels })
        .from(messages)
        .where(and(eq(messages.accountId, this.account.id), eq(messages.mailbox, this.status.mailbox ?? ''), eq(messages.uid, u.uid)))
        .get();
      if (!msg) continue;
      updateFlags(db, msg.id, {
        flags: u.flags,
        labels: u.labels ?? (JSON.parse(msg.labels ?? '[]') as string[]),
        uid: u.uid,
        mailbox: this.status.mailbox,
        gmMsgid: u.gmMsgid,
      });
      this.touched.add(msg.conversationId);
    }
    this.flushEvents();
  }

  private flushEvents() {
    if (this.touched.size) {
      bus.publish({ type: 'conversations', ids: [...this.touched] });
      this.touched.clear();
    }
    this.publishStatus();
  }

  private loadRow(mailbox: string, mb: MailboxState): SyncRow {
    const { db } = this.deps.ctx;
    const existing = db
      .select()
      .from(syncState)
      .where(and(eq(syncState.accountId, this.account.id), eq(syncState.mailbox, mailbox)))
      .get();
    // UIDVALIDITY cambiato: i UID salvati non valgono più. Si riparte; i duplicati
    // vengono riconosciuti in ingest tramite X-GM-MSGID / Message-ID.
    if (existing && existing.uidValidity === mb.uidValidity) {
      this.status.backfillDone = existing.backfillDone;
      this.status.lowestUid = existing.lowestUid;
      return existing;
    }
    const fresh: SyncRow = {
      accountId: this.account.id,
      mailbox,
      uidValidity: mb.uidValidity,
      lastUid: null,
      lowestUid: null,
      highestModseq: null,
      oldestSyncedDate: null,
      backfillDone: false,
      updatedAt: now(),
    };
    db.insert(syncState)
      .values(fresh)
      .onConflictDoUpdate({ target: [syncState.accountId, syncState.mailbox], set: { ...fresh } })
      .run();
    return fresh;
  }

  private saveRow(patch: Partial<SyncRow>) {
    this.row = { ...this.row, ...patch, updatedAt: now() };
    this.deps.ctx.db
      .update(syncState)
      .set({ ...patch, updatedAt: this.row.updatedAt })
      .where(and(eq(syncState.accountId, this.account.id), eq(syncState.mailbox, this.row.mailbox)))
      .run();
    this.status.lowestUid = this.row.lowestUid;
    this.status.backfillDone = this.row.backfillDone;
  }

  private setPhase(phase: SyncPhase, error: string | null = null) {
    this.status.phase = phase;
    this.status.error = error;
    this.publishStatus();
  }

  private publishStatus() {
    this.status.updatedAt = now();
    bus.publish({ type: 'sync', status: { ...this.status } });
  }

  private waitForWake(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
