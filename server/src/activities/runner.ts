// Esecuzione della coda attività: a blocchi ogni N minuti (impostazioni), oppure subito
// per le attività urgenti o su richiesta. Un'esecuzione alla volta; una connessione IMAP
// per account per blocco, aperta solo se serve.

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AccountDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { messages } from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import type { BlobStore } from '../store/blobs.ts';
import type { MailProviderClient } from '../mail/provider.ts';
import { buildMime, type SmtpSender } from '../mail/smtp.ts';
import { describeImapError } from '../accounts/service.ts';
import type { ActivityService, ConversationOpPayload, FlagsPayload, SendPayload } from './service.ts';

type ActivityRow = NonNullable<ReturnType<ActivityService['get']>>;

export interface RunnerDeps {
  db: Db;
  blobs: BlobStore;
  activities: ActivityService;
  getAccount: (id: string) => AccountDto | undefined;
  createProvider: (account: AccountDto) => MailProviderClient;
  sendSmtp: SmtpSender;
  batchMinutes: () => number;
}

export class ActivityRunner {
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  nextRunAt: number | null = null;

  constructor(private deps: RunnerDeps) {}

  start() {
    this.deps.activities.recoverInterrupted();
    this.schedule();
    // Attività urgenti rimaste in sospeso da una sessione precedente.
    const urgent = this.deps.activities.pending().filter((a) => a.urgent);
    if (urgent.length) void this.run(urgent.map((a) => a.id));
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** Da richiamare quando cambia l'intervallo nelle impostazioni. */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(1, this.deps.batchMinutes()) * 60_000;
    this.nextRunAt = now() + ms;
    this.timer = setTimeout(() => {
      void this.run().finally(() => this.schedule());
    }, ms);
    this.timer.unref?.();
    bus.publish({ type: 'activities' });
  }

  /** Esegue le attività in attesa (tutte, o solo quelle indicate). */
  run(ids?: string[]): Promise<void> {
    this.chain = this.chain.then(() => this.runBatch(ids)).catch(() => {});
    return this.chain;
  }

  private async runBatch(ids?: string[]) {
    const pending = this.deps.activities.pending(ids);
    if (!pending.length) return;

    const byAccount = new Map<string, ActivityRow[]>();
    for (const a of pending) {
      const list = byAccount.get(a.accountId ?? '') ?? [];
      list.push(a);
      byAccount.set(a.accountId ?? '', list);
    }

    for (const [accountId, list] of byAccount) {
      const account = this.deps.getAccount(accountId);
      let provider: MailProviderClient | null = null;
      const imap = async () => {
        if (!account) throw new Error('Account non trovato');
        if (!provider) {
          provider = this.deps.createProvider(account);
          await provider.connect();
        }
        return provider;
      };
      try {
        for (const a of list) {
          // Potrebbe essere stata annullata nel frattempo.
          if (this.deps.activities.get(a.id)?.status !== 'pending') continue;
          this.deps.activities.setStatus(a.id, 'running');
          try {
            if (!account) throw new Error('Account non trovato');
            await this.execute(a, account, imap);
            this.deps.activities.setStatus(a.id, 'done');
          } catch (err) {
            this.deps.activities.setStatus(a.id, 'failed', describeImapError(err));
            if (a.kind === 'send') {
              const p = JSON.parse(a.payload) as SendPayload;
              this.deps.db.update(messages).set({ outgoingStatus: 'failed' }).where(eq(messages.id, p.messageId)).run();
              bus.publish({ type: 'conversations', ids: [p.conversationId] });
            }
          }
        }
      } finally {
        await (provider as MailProviderClient | null)?.close().catch(() => {});
      }
    }
  }

  private async execute(a: ActivityRow, account: AccountDto, imap: () => Promise<MailProviderClient>) {
    switch (a.kind) {
      case 'set_flags': {
        const p = JSON.parse(a.payload) as FlagsPayload;
        for (const [mailbox, uids] of this.uidsByMailbox(p.messageIds)) {
          const client = await imap();
          if (p.add?.length) await client.addFlags(mailbox, uids, p.add);
          if (p.remove?.length) await client.removeFlags(mailbox, uids, p.remove);
        }
        return;
      }
      case 'archive':
      case 'spam':
      case 'trash': {
        const p = JSON.parse(a.payload) as ConversationOpPayload;
        // Si risolvono i messaggi al momento dell'esecuzione: include le risposte arrivate nel frattempo.
        const ids = this.deps.db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.conversationId, p.conversationId), eq(messages.accountId, account.id), isNull(messages.deletedAt)))
          .all()
          .map((m) => m.id);
        for (const [mailbox, uids] of this.uidsByMailbox(ids)) {
          const client = await imap();
          if (a.kind === 'archive') await client.archive(mailbox, uids);
          else if (a.kind === 'spam') await client.moveToSpam(mailbox, uids);
          else await client.moveToTrash(mailbox, uids);
        }
        return;
      }
      case 'send': {
        const p = JSON.parse(a.payload) as SendPayload;
        const msg = this.deps.db.select().from(messages).where(eq(messages.id, p.messageId)).get();
        if (!msg || msg.deletedAt) throw new Error('Messaggio da inviare non trovato');
        const raw = await buildMime({
          from: { name: p.fromName, email: account.email },
          to: p.to,
          cc: p.cc,
          bcc: p.bcc,
          subject: p.subject,
          text: p.body,
          html: p.html ?? null,
          messageId: msg.rfcMessageId!,
          inReplyTo: p.inReplyTo,
          references: p.references,
          date: new Date(),
          attachments: (p.attachments ?? []).map((a) => ({ filename: a.filename, content: this.deps.blobs.read(a.blobSha), contentType: a.mime })),
        });
        await this.deps.sendSmtp(account, raw, { from: account.email, to: [...p.to, ...p.cc, ...p.bcc] });
        // Gmail salva da sé l'inviata in "Tutti i messaggi"; gli altri server no.
        if (account.provider !== 'gmail') await (await imap()).appendToSent(raw);
        const sha = this.deps.blobs.put(raw, 'message/rfc822');
        const t = now();
        this.deps.db
          .update(messages)
          .set({ outgoingStatus: 'sent', rawBlobSha: sha, date: t, updatedAt: t })
          .where(eq(messages.id, msg.id))
          .run();
        bus.publish({ type: 'conversations', ids: [p.conversationId] });
        return;
      }
    }
  }

  private uidsByMailbox(messageIds: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    if (!messageIds.length) return out;
    const rows = this.deps.db
      .select({ uid: messages.uid, mailbox: messages.mailbox })
      .from(messages)
      .where(and(inArray(messages.id, messageIds), isNotNull(messages.uid), isNotNull(messages.mailbox)))
      .all();
    for (const r of rows) {
      const list = out.get(r.mailbox!) ?? [];
      list.push(r.uid!);
      out.set(r.mailbox!, list);
    }
    return out;
  }
}
