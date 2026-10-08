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

const VERSION_WORDS = [
  'final', 'finale', 'def', 'definitivo', 'definitiva', 'ultimo', 'ultima', 'bozza', 'draft',
  'revised', 'rivisto', 'rivista', 'corretto', 'corretta', 'correzioni', 'aggiornato', 'aggiornata',
  'updated', 'new', 'nuovo', 'nuova', 'ok', 'commenti', 'commentato', 'comments', 'tracked', 'clean', 'pulito',
];
const TRAILING = [
  /[\s_.-]*\(\d+\)$/, // "relazione (1)"
  /[\s_.-]+-?\s*(copia|copy)$/, // "relazione - copia"
  // Serve un separatore prima del marcatore: "chapter2" non è "chapte" + "r2".
  /(?:^|[\s_.-]+)(v|ver|vers|version|versione|rev|revision|r)[\s_.-]?\d+(\.\d+)*$/, // "_v2", "-rev3", "versione 2", "v1.2"
  /[\s_.-]+\d{4}[\s_.-]?\d{2}[\s_.-]?\d{2}$/, // "_2026-10-07", "20261007"
  /[\s_.-]+\d{1,2}[\s_.-]\d{1,2}[\s_.-]\d{2,4}$/, // "_07.10.2026"
  new RegExp(`[\\s_.-]+(${VERSION_WORDS.join('|')})$`), // "_final", "-def", " bozza"
];
const LEADING = [/^(copia di|copy of)\s+/];

/**
 * Chiave del "file" a cui appartiene un allegato: stesso nome a meno di segni di versione
 * (numeri, copie, parole come "final", date) e con la stessa estensione.
 */
export function normalizeFileName(name: string | null): string {
  const clean = (name ?? 'allegato').normalize('NFC').trim().replace(/\s+/g, ' ');
  const dot = clean.lastIndexOf('.');
  const hasExt = dot > 0 && dot < clean.length - 1 && clean.length - dot <= 6;
  const ext = hasExt ? clean.slice(dot + 1).toLowerCase() : '';
  let stem = hasExt ? clean.slice(0, dot) : clean;

  stem = stem.toLowerCase();
  for (const re of LEADING) stem = stem.replace(re, '');
  let prev: string;
  do {
    prev = stem;
    for (const re of TRAILING) stem = stem.replace(re, '');
  } while (stem !== prev && stem.length > 0);

  stem = stem.replace(/[\s_.-]+/g, ' ').trim();
  // Nome fatto solo di segni di versione ("v2.pdf"): si tiene quello originale.
  if (!stem) stem = (hasExt ? clean.slice(0, dot) : clean).toLowerCase();
  return ext ? `${stem}.${ext}` : stem;
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
