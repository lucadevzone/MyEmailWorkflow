// Versioni dei file allegati in una conversazione, alla maniera di git:
// - un "file" è l'insieme degli allegati con lo stesso nome (normalizzato);
// - una "versione" nasce solo quando il contenuto cambia (blob sha256 diverso);
// - lo stesso contenuto rimandato non crea una versione, ma resta nella storia come reinvio.
// Le versioni si calcolano in lettura: restano corrette con import fuori ordine e unioni di conversazioni.

import type { FileDto, FileVersionDto, PersonRef } from '@mmw/shared';

export interface AttachmentOccurrence {
  id: string;
  filename: string | null;
  mime: string | null;
  size: number;
  blobSha: string;
  messageId: string;
  date: number;
  from: PersonRef | null;
}

/** v1: stesso nome a meno di maiuscole e spazi. (v2: nomi simili, es. "report_v2.pdf".) */
export function normalizeFileName(name: string | null): string {
  return (name ?? 'allegato').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildFileHistory(items: AttachmentOccurrence[]): FileDto[] {
  const byName = new Map<string, AttachmentOccurrence[]>();
  for (const a of items) {
    const k = normalizeFileName(a.filename);
    byName.set(k, [...(byName.get(k) ?? []), a]);
  }

  const files: FileDto[] = [];
  for (const [key, list] of byName) {
    list.sort((a, b) => a.date - b.date);
    const versions: FileVersionDto[] = [];
    const bySha = new Map<string, FileVersionDto>();
    for (const a of list) {
      const existing = bySha.get(a.blobSha);
      if (existing) {
        existing.resent.push({ attachmentId: a.id, messageId: a.messageId, date: a.date, from: a.from });
        continue;
      }
      const v: FileVersionDto = {
        no: versions.length + 1,
        attachmentId: a.id,
        messageId: a.messageId,
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        date: a.date,
        from: a.from,
        resent: [],
      };
      versions.push(v);
      bySha.set(a.blobSha, v);
    }
    const latest = versions[versions.length - 1]!;
    files.push({ key, name: latest.filename ?? 'allegato', latest, versions: [...versions].reverse() });
  }
  return files.sort((a, b) => b.latest.date - a.latest.date);
}

/** Per ogni allegato: a quale versione del suo file corrisponde. */
export function versionIndex(files: FileDto[]): Map<string, { versionNo: number; versionCount: number }> {
  const out = new Map<string, { versionNo: number; versionCount: number }>();
  for (const f of files) {
    for (const v of f.versions) {
      const info = { versionNo: v.no, versionCount: f.versions.length };
      out.set(v.attachmentId, info);
      for (const r of v.resent) out.set(r.attachmentId, info);
    }
  }
  return out;
}
