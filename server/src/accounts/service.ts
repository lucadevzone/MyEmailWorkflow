import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AccountDto, ConnectionTestResult } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { accounts } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { forgetSecret, isValidCredentialRef, storeAccountPassword } from '../mail/credentials.ts';
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
    /** La password (o app password di Google): va nel Portachiavi, mai nel DB. */
    password: z.string().min(1).optional(),
    /** Solo sviluppo e test: riferimento già pronto (env:NOME_VARIABILE). */
    credentialRef: z.string().refine(isValidCredentialRef, 'Formato atteso: env:NOME_VARIABILE').optional(),
    color: z.string().nullable().optional(),
  })
  .refine((a) => !!a.password || !!a.credentialRef, { message: 'Serve la password' })
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
    signatureHtml: row.signatureHtml,
    signatureText: row.signatureText,
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
    const id = newId();
    const row: AccountRow = {
      id,
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
      credentialRef: input.password ? storeAccountPassword(id, input.password) : input.credentialRef!,
      color: input.color ?? null,
      signatureHtml: null,
      signatureText: null,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
    };
    this.db.insert(accounts).values(row).run();
    return toDto(row);
  }

  /** Firma dell'account (HTML dall'editor + versione testo); vuota = nessuna firma. */
  setSignature(id: string, sig: { html: string | null; text: string | null }): AccountDto {
    if (!this.get(id)) throw new Error('Account non trovato');
    const empty = !sig.text?.trim();
    this.db
      .update(accounts)
      .set({ signatureHtml: empty ? null : sig.html, signatureText: empty ? null : sig.text, updatedAt: now() })
      .where(eq(accounts.id, id))
      .run();
    return this.get(id)!;
  }

  /** Nuova password: va nel Portachiavi e l'account smette di usare un eventuale env:. */
  setPassword(id: string, password: string): AccountDto {
    const account = this.get(id);
    if (!account) throw new Error('Account non trovato');
    if (!password) throw new Error('Serve la password');
    const ref = storeAccountPassword(id, password);
    this.db.update(accounts).set({ credentialRef: ref, updatedAt: now() }).where(eq(accounts.id, id)).run();
    return this.get(id)!;
  }

  /**
   * All'avvio: gli account con la password in una variabile d'ambiente (env:...) la spostano nel
   * Portachiavi, se la variabile è impostata. Restituisce gli account convertiti.
   */
  migrateEnvCredentials(): string[] {
    const done: string[] = [];
    for (const a of this.list()) {
      const m = /^env:(.+)$/.exec(a.credentialRef);
      const value = m ? process.env[m[1]!] : undefined;
      if (!value) continue;
      this.setPassword(a.id, value);
      done.push(a.email);
    }
    return done;
  }

  remove(id: string): boolean {
    const t = now();
    const ref = this.get(id)?.credentialRef;
    const res = this.db
      .update(accounts)
      .set({ deletedAt: t, updatedAt: t })
      .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
      .run();
    if (res.changes > 0 && ref) forgetSecret(ref);
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
