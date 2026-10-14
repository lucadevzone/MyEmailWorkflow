import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client.ts';
import { blobs } from '../db/schema.ts';
import { now } from '../lib/ids.ts';

// Storage content-addressed: lo stesso contenuto viene salvato una sola volta.
// Lo sha256 servirà anche a riconoscere allegati identici tra versioni.
export class BlobStore {
  constructor(private db: Db, private dir: string) {}

  /** Uso su più PC: se il file non c'è qui, si prova a prenderlo dalla cartella condivisa. */
  private fallback: ((sha: string) => boolean) | null = null;
  setFallback(fn: ((sha: string) => boolean) | null) {
    this.fallback = fn;
  }

  pathFor(sha: string): string {
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  put(data: Buffer, mime: string | null = null): string {
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const file = this.pathFor(sha);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
    }
    this.db.insert(blobs).values({ sha256: sha, size: data.length, mime, createdAt: now() }).onConflictDoNothing().run();
    return sha;
  }

  read(sha: string): Buffer {
    const file = this.pathFor(sha);
    if (!fs.existsSync(file)) this.fallback?.(sha);
    return fs.readFileSync(file);
  }
}
