// File caricati da te (fase 4, docs/03-uso-su-piu-pc.md): risorse, foto dei contatti, allegati delle bozze
// e degli invii in coda. La posta e i suoi allegati arrivano da Gmail su ogni PC; questi file invece
// esistono solo dove li hai caricati, quindi viaggiano nella cartella condivisa `files/<sha256>`.
// Un file per contenuto, mai modificato: si copia solo quello che manca.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { BlobStore } from '../store/blobs.ts';

export const FILES_DIR = 'files';

/** Contenuti (sha256) a cui i dati personali fanno riferimento. */
export function personalBlobShas(sqlite: Database.Database, schema = 'main'): string[] {
  const rows = sqlite
    .prepare(
      `select blob_sha as s from ${schema}.resources where blob_sha is not null
       union select avatar_blob_sha from ${schema}.contacts where avatar_blob_sha is not null
       union select json_extract(j.value, '$.blobSha') from ${schema}.drafts d, json_each(d.attachments) j
       union select json_extract(j.value, '$.blobSha') from ${schema}.activities a, json_each(a.payload, '$.attachments') j
         where a.status in ('pending', 'running', 'failed') and json_valid(a.payload)
       union select html_blob_sha from ${schema}.messages where direction = 'out' and outgoing_status in ('queued', 'failed') and html_blob_sha is not null`,
    )
    .all() as { s: string | null }[];
  return rows.map((r) => r.s).filter((s): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s));
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Alla consegna: mette nella cartella condivisa i file che non ci sono ancora. */
export function uploadFiles(sqlite: Database.Database, blobs: BlobStore, folder: string): number {
  const dir = path.join(folder, FILES_DIR);
  let copied = 0;
  for (const sha of personalBlobShas(sqlite)) {
    const dest = path.join(dir, sha);
    const src = blobs.pathFor(sha);
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, `${dest}.tmp`);
    fs.renameSync(`${dest}.tmp`, dest);
    copied++;
  }
  return copied;
}

/**
 * Copia in locale un file dalla cartella condivisa, se c'è ed è integro (Google Drive potrebbe non averlo
 * ancora scaricato del tutto). Restituisce true se ora il file è disponibile qui.
 */
export function fetchFile(blobs: BlobStore, folder: string, sha: string): boolean {
  const local = blobs.pathFor(sha);
  if (fs.existsSync(local)) return true;
  const src = path.join(folder, FILES_DIR, sha);
  if (!fs.existsSync(src) || sha256(src) !== sha) return false;
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.copyFileSync(src, `${local}.${process.pid}.tmp`);
  fs.renameSync(`${local}.${process.pid}.tmp`, local);
  return true;
}

/** Dopo la presa: porta qui i file che mancano. Restituisce quanti ne mancano ancora. */
export function downloadFiles(sqlite: Database.Database, blobs: BlobStore, folder: string): { copied: number; missing: number } {
  let copied = 0;
  let missing = 0;
  for (const sha of personalBlobShas(sqlite)) {
    if (fs.existsSync(blobs.pathFor(sha))) continue;
    if (fetchFile(blobs, folder, sha)) copied++;
    else missing++;
  }
  return { copied, missing };
}
