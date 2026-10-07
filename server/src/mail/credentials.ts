// Risoluzione delle credenziali a partire da un riferimento salvato sull'account.
// Il DB contiene solo il riferimento, mai il segreto.
//
// Schemi supportati:
//   env:NOME_VARIABILE   → valore della variabile d'ambiente (MVP, da .env.local)
// Futuri: keychain:..., oauth2:... (refresh token gestito dal CredentialProvider OAuth).

export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

export class CredentialError extends Error {}

export function resolveSecret(ref: string): string {
  const [scheme, ...rest] = ref.split(':');
  const key = rest.join(':');
  if (scheme === 'env') {
    const value = process.env[key];
    if (!value) throw new CredentialError(`Variabile d'ambiente ${key} non impostata (controlla .env.local)`);
    return value;
  }
  throw new CredentialError(`Schema di credenziale non supportato: "${scheme}"`);
}

export function isValidCredentialRef(ref: string): boolean {
  return /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref);
}

export function resolveImapAuth(account: { username: string; authType: string; credentialRef: string }): ImapAuth {
  if (account.authType === 'password') {
    // Le app password di Google si mostrano con spazi ("abcd efgh ..."): vanno tolti.
    return { user: account.username, pass: resolveSecret(account.credentialRef).replace(/\s+/g, '') };
  }
  throw new CredentialError('Autenticazione OAuth2 non ancora implementata');
}
