import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AccountDto, ConnectionTestResult } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { accounts } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { isValidCredentialRef } from '../mail/credentials.ts';
import { createProvider, type ProviderAccount } from '../mail/factory.ts';
import type { MailProviderClient } from '../mail/provider.ts';

const GMAIL_DEFAULTS = {
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpSecure: true,
};

export const createAccountSchema = z
  .object({
    name: z.string().trim().min(1),
    email: z.email(),
    provider: z.enum(['gmail', 'imap']),
    imapHost: z.string().trim().min(1).optional(),
    imapPort: z.number().int().positive().optional(),
    imapSecure: z.boolean().optional(),
    smtpHost: z.string().trim().min(1).optional(),
    smtpPort: z.number().int().positive().optional(),
    smtpSecure: z.boolean().optional(),
    username: z.string().trim().min(1).optional(),
    credentialRef: z.string().refine(isValidCredentialRef, 'Formato atteso: env:NOME_VARIABILE'),
    color: z.string().nullable().optional(),
  })
  .refine((a) => a.provider === 'gmail' || (a.imapHost && a.smtpHost), {
    message: 'Per un account IMAP generico servono imapHost e smtpHost',
  });

export type CreateAccount = z.infer<typeof createAccountSchema>;

type AccountRow = typeof accounts.$inferSelect;

function toDto(row: AccountRow): AccountDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    provider: row.provider,
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapSecure: row.imapSecure,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    username: row.username,
    authType: row.authType,
    credentialRef: row.credentialRef,
    color: row.color,
  };
}

export class AccountService {
  constructor(private db: Db) {}

  list(): AccountDto[] {
    return this.db.select().from(accounts).where(isNull(accounts.deletedAt)).all().map(toDto);
  }

  get(id: string): AccountDto | undefined {
    const row = this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
      .get();
    return row && toDto(row);
  }

  create(input: CreateAccount): AccountDto {
    const defaults =
      input.provider === 'gmail'
        ? GMAIL_DEFAULTS
        : { imapPort: 993, imapSecure: true, smtpPort: 465, smtpSecure: true };
    const t = now();
    const row: AccountRow = {
      id: newId(),
      name: input.name,
      email: input.email,
      provider: input.provider,
      imapHost: input.imapHost ?? (defaults as typeof GMAIL_DEFAULTS).imapHost,
      imapPort: input.imapPort ?? defaults.imapPort,
      imapSecure: input.imapSecure ?? defaults.imapSecure,
      smtpHost: input.smtpHost ?? (defaults as typeof GMAIL_DEFAULTS).smtpHost,
      smtpPort: input.smtpPort ?? defaults.smtpPort,
      smtpSecure: input.smtpSecure ?? defaults.smtpSecure,
      username: input.username ?? input.email,
      authType: 'password',
      credentialRef: input.credentialRef,
      color: input.color ?? null,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
    };
    this.db.insert(accounts).values(row).run();
    return toDto(row);
  }

  remove(id: string): boolean {
    const t = now();
    const res = this.db
      .update(accounts)
      .set({ deletedAt: t, updatedAt: t })
      .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
      .run();
    return res.changes > 0;
  }

  async testConnection(id: string): Promise<ConnectionTestResult> {
    const account = this.get(id);
    if (!account) return { ok: false, error: 'Account non trovato' };
    return testImapConnection(account);
  }
}

export async function testImapConnection(account: ProviderAccount): Promise<ConnectionTestResult> {
  let provider: MailProviderClient | undefined;
  try {
    provider = createProvider(account);
    await provider.connect();
    const [mailboxes, syncMailbox] = [await provider.listMailboxes(), await provider.syncMailbox()];
    return { ok: true, syncMailbox, mailboxes, capabilities: provider.capabilities() };
  } catch (err) {
    return { ok: false, error: describeImapError(err) };
  } finally {
    await provider?.close().catch(() => {});
  }
}

export function describeImapError(err: unknown): string {
  const e = err as { message?: string; authenticationFailed?: boolean; responseText?: string };
  if (e.authenticationFailed) {
    return `Autenticazione fallita${e.responseText ? `: ${e.responseText}` : ''}. Per Gmail serve una app password (con verifica in due passaggi attiva).`;
  }
  return e.responseText ?? e.message ?? String(err);
}
