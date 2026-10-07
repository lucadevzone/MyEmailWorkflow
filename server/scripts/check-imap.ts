// Verifica la connessione IMAP all'account di prova senza passare dal DB.
// Uso: imposta MMW_TEST_EMAIL e MMW_TEST_APP_PASSWORD in .env.local, poi `pnpm check:imap`.
import { testImapConnection } from '../src/accounts/service.ts';

const email = process.env.MMW_TEST_EMAIL;
if (!email) {
  console.error('MMW_TEST_EMAIL non impostata in .env.local');
  process.exit(1);
}

const result = await testImapConnection({
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  username: email,
  authType: 'password',
  credentialRef: 'env:MMW_TEST_APP_PASSWORD',
});

if (!result.ok) {
  console.error(`✗ Connessione fallita: ${result.error}`);
  process.exit(1);
}
console.log(`✓ Connesso come ${email}`);
console.log(`  Cartella di sync: ${result.syncMailbox}`);
console.log(`  Gmail: ${result.capabilities?.includes('X-GM-EXT-1') ? 'sì' : 'no'}`);
for (const m of result.mailboxes ?? []) {
  console.log(`  ${m.specialUse?.padEnd(8) ?? '        '} ${m.path}  (${m.messages ?? '?'} msg, ${m.unseen ?? '?'} non letti)`);
}
