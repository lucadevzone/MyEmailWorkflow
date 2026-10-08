import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildServices } from '../src/services.ts';
import { ingestMessage } from '../src/ingest/ingest.ts';
import { ConversationService } from '../src/conversations/service.ts';
import { buildFileHistory, normalizeFileName } from '../src/conversations/versions.ts';

const mario = { name: 'Mario', email: 'mario@x.it' };
const anna = { name: 'Anna', email: 'anna@y.it' };
const occ = (id: string, filename: string, sha: string, date: number, from = mario) => ({
  id, filename, mime: 'application/pdf', size: 10, blobSha: sha, messageId: `m-${id}`, date, from,
});

describe('storia dei file (funzione pura)', () => {
  it('nuova versione solo quando cambia il contenuto; i reinvii restano nella storia', () => {
    const [file] = buildFileHistory([
      occ('a', 'Report.pdf', 'sha1', 1, mario),
      occ('b', 'report.pdf', 'sha1', 2, anna), // stesso contenuto rimandato da Anna
      occ('c', 'report.pdf ', 'sha2', 3, mario), // contenuto nuovo
    ]);
    expect(file!.versions.map((v) => [v.no, v.from?.name, v.date])).toEqual([
      [2, 'Mario', 3],
      [1, 'Mario', 1],
    ]);
    expect(file!.latest.attachmentId).toBe('c');
    expect(file!.versions[1]!.resent).toMatchObject([{ attachmentId: 'b', from: anna, date: 2 }]);
  });

  it('nomi diversi sono file diversi; ordine per ultima versione', () => {
    const files = buildFileHistory([occ('a', 'budget.xlsx', 's1', 5), occ('b', 'report.pdf', 's2', 9)]);
    expect(files.map((f) => f.name)).toEqual(['report.pdf', 'budget.xlsx']);
  });

  it('un contenuto tornato uguale a una versione precedente non crea una versione', () => {
    const [file] = buildFileHistory([occ('a', 'x.pdf', 's1', 1), occ('b', 'x.pdf', 's2', 2), occ('c', 'x.pdf', 's1', 3)]);
    expect(file!.versions).toHaveLength(2);
    expect(file!.versions[1]!.resent.map((r) => r.attachmentId)).toEqual(['c']);
  });
});

describe('versioni nelle conversazioni', () => {
  let s: ReturnType<typeof buildServices>;
  let uid = 1;
  beforeEach(() => {
    const { db, sqlite } = openDb(':memory:');
    runMigrations(db);
    s = buildServices(db, sqlite, fs.mkdtempSync(path.join(os.tmpdir(), 'mmw-blobs-')), {
      createProvider: () => {
        throw new Error('no imap');
      },
    });
    s.accounts.create({ name: 'Luca', email: 'me@gmail.com', provider: 'gmail', credentialRef: 'env:X' });
  });

  const withPdf = (id: string, from: string, date: string, content: string, inReplyTo?: string) =>
    Buffer.from(
      [
        `Message-ID: ${id}`, `From: ${from}`, 'To: me@gmail.com', 'Subject: Report', `Date: ${date}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : '', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '',
        '--B', 'Content-Type: text/plain', '', 'in allegato', '--B',
        'Content-Type: application/pdf; name="Report.pdf"', 'Content-Disposition: attachment; filename="Report.pdf"',
        'Content-Transfer-Encoding: base64', '', Buffer.from(content).toString('base64'), '--B--', '',
      ]
        .filter((l, i) => l !== '' || i > 6)
        .join('\r\n'),
    );

  it('calcola le versioni per data anche se lo storico arriva fuori ordine', async () => {
    const account = s.accounts.list()[0]!;
    const ing = (src: Buffer) => ingestMessage(s, account, { uid: uid++, mailbox: 'All', source: src, flags: [], labels: [], gmThreadId: 'T' });
    // Arriva prima la versione nuova (sync recente), poi le vecchie (backfill).
    await ing(withPdf('<3@x>', 'Mario <mario@x.it>', 'Fri, 09 Oct 2026 10:00:00 +0200', 'versione due', '<2@x>'));
    await ing(withPdf('<1@x>', 'Mario <mario@x.it>', 'Wed, 07 Oct 2026 10:00:00 +0200', 'versione uno'));
    const last = await ing(withPdf('<2@x>', 'Anna <anna@y.it>', 'Thu, 08 Oct 2026 10:00:00 +0200', 'versione uno', '<1@x>'));

    const conv = new ConversationService(s.db);
    expect(conv.list({ view: 'inbox' })[0]!.attachmentCount).toBe(1);
    const detail = conv.get(last.conversationId)!;
    expect(detail.files).toHaveLength(1);
    const f = detail.files[0]!;
    expect(f.versions.map((v) => [v.no, v.from?.name])).toEqual([
      [2, 'Mario'],
      [1, 'Mario'],
    ]);
    expect(f.versions[1]!.resent.map((r) => r.from?.name)).toEqual(['Anna']);
    // Ogni allegato nei messaggi sa a quale versione corrisponde.
    const byMsg = Object.fromEntries(detail.messages.map((m) => [m.subject && m.date, m.attachments[0]?.versionNo]));
    expect(Object.values(byMsg).sort()).toEqual([1, 1, 2]);
    expect(detail.messages[0]!.attachments[0]!.versionCount).toBe(2);
  });
});

describe('nomi simili', () => {
  const same = (a: string, b: string) => expect(normalizeFileName(a), `${a} ~ ${b}`).toBe(normalizeFileName(b));
  const diff = (a: string, b: string) => expect(normalizeFileName(a), `${a} ≠ ${b}`).not.toBe(normalizeFileName(b));

  it('riconosce le varianti tipiche dello stesso documento', () => {
    for (const n of [
      'Relazione_v2.docx', 'relazione-rev3.docx', 'Relazione versione 2.docx', 'relazione v1.2.docx',
      'relazione (1).docx', 'Copia di relazione.docx', 'relazione - copia.docx', 'relazione_final.docx',
      'Relazione DEF.docx', 'relazione_finale_v3.docx', 'relazione_2026-10-07.docx', 'relazione_20261007.docx',
      'relazione 07.10.2026.docx', 'relazione_commenti.docx', 'relazione_bozza.docx',
    ]) same(n, 'relazione.docx');
    same('Piano di lavoro_v2.xlsx', 'piano_di_lavoro.xlsx');
  });

  it('tiene distinti documenti diversi', () => {
    diff('relazione.docx', 'relazione.pdf');
    diff('relazione.docx', 'relazione tecnica.docx');
    diff('budget 2025.xlsx', 'budget 2026.xlsx');
    diff('allegato A.pdf', 'allegato B.pdf');
    diff('v2.pdf', 'v3.pdf');
    diff('chapter2.pdf', 'chapter3.pdf');
    // Le sigle in fondo al nome non sono segni di versione.
    diff('budget_EU.xlsx', 'budget.xlsx');
    diff('relazione_LS.docx', 'relazione.docx');
    diff('server.pdf', 'serve.pdf');
  });

  it('nella storia unisce le varianti come versioni dello stesso file', () => {
    const [file, ...rest] = buildFileHistory([
      occ('a', 'Relazione.docx', 's1', 1, mario),
      occ('b', 'Relazione_rivista.docx', 's2', 2, anna),
      occ('c', 'Relazione_v3_final.docx', 's3', 3, mario),
    ]);
    expect(rest).toHaveLength(0);
    expect(file!.name).toBe('Relazione_v3_final.docx');
    expect(file!.versions.map((v) => [v.no, v.filename])).toEqual([
      [3, 'Relazione_v3_final.docx'],
      [2, 'Relazione_rivista.docx'],
      [1, 'Relazione.docx'],
    ]);
  });
});
