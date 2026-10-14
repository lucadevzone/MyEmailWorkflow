// Risoluzione delle credenziali a partire da un riferimento salvato sull'account.
// Il DB contiene solo il riferimento, mai il segreto.
//
// Schemi supportati:
//   keychain:ID_ACCOUNT  → password nel portachiavi del sistema (macOS: Portachiavi), servizio "my-mail-workflow"
//   env:NOME_VARIABILE   → variabile d'ambiente (solo sviluppo e test; gli account esistenti si convertono all'avvio)
// Futuro: oauth2:... (refresh token nel portachiavi).

import { Entry } from '@napi-rs/keyring';

export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

export class CredentialError extends Error {}

/** Dove stanno i segreti. Nei test si usa una versione in memoria per non toccare il portachiavi vero. */
export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const SERVICE = 'my-mail-workflow';

export function keychainStore(): SecretStore {
  return {
    get: (key) => new Entry(SERVICE, key).getPassword() ?? null,
    set: (key, value) => new Entry(SERVICE, key).setPassword(value),
    delete: (key) => void new Entry(SERVICE, key).deletePassword(),
  };
}

export function memoryStore(): SecretStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k) };
}

let store: SecretStore = process.env.VITEST ? memoryStore() : keychainStore();

export function setSecretStore(s: SecretStore) {
  store = s;
}

export function resolveSecret(ref: string): string {
  const [scheme, ...rest] = ref.split(':');
  const key = rest.join(':');
  if (scheme === 'keychain') {
    let value: string | null;
    try {
      value = store.get(key);
    } catch (err) {
      throw new CredentialError(`Portachiavi non accessibile: ${(err as Error).message}`);
    }
    if (!value) throw new CredentialError("Password non trovata nel Portachiavi: reinseriscila nelle Impostazioni dell'account");
    return value;
  }
  if (scheme === 'env') {
    const value = process.env[key];
    if (!value) throw new CredentialError(`Variabile d'ambiente ${key} non impostata (controlla .env.local)`);
    return value;
  }
  throw new CredentialError(`Schema di credenziale non supportato: "${scheme}"`);
}

/** Il segreto c'è (senza leggerlo fuori da qui)? */
export function hasSecret(ref: string): boolean {
  try {
    return !!resolveSecret(ref);
  } catch {
    return false;
  }
}

export function isValidCredentialRef(ref: string): boolean {
  return /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || /^keychain:[A-Za-z0-9]+$/.test(ref);
}

/** Salva la password dell'account nel portachiavi e restituisce il riferimento da tenere nel DB. */
export function storeAccountPassword(accountId: string, password: string): string {
  try {
    store.set(accountId, password);
  } catch (err) {
    throw new CredentialError(`Impossibile salvare la password nel Portachiavi: ${(err as Error).message}`);
  }
  return `keychain:${accountId}`;
}

/** Cancella il segreto, se sta nel portachiavi (le variabili d'ambiente non si toccano). */
export function forgetSecret(ref: string) {
  const [scheme, key] = ref.split(':');
  if (scheme !== 'keychain' || !key) return;
  try {
    store.delete(key);
  } catch {
    /* già assente */
  }
}

export function resolveImapAuth(account: { username: string; authType: string; credentialRef: string }): ImapAuth {
  if (account.authType === 'password') {
    // Le app password di Google si mostrano con spazi ("abcd efgh ..."): vanno tolti.
    return { user: account.username, pass: resolveSecret(account.credentialRef).replace(/\s+/g, '') };
  }
  throw new CredentialError('Autenticazione OAuth2 non ancora implementata');
}
