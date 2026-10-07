import type { AccountDto } from '@mmw/shared';
import { resolveImapAuth } from './credentials.ts';
import { ImapProvider } from './imap-provider.ts';
import type { MailProviderClient } from './provider.ts';

export type ProviderAccount = Pick<AccountDto, 'imapHost' | 'imapPort' | 'imapSecure' | 'username' | 'authType' | 'credentialRef'>;

export function createProvider(account: ProviderAccount): MailProviderClient {
  return new ImapProvider({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: resolveImapAuth(account),
  });
}
