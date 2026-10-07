// Estrae dal corpo di un'email solo il testo nuovo: niente parti citate, niente firma.
// È la base per riassunti ed embedding: senza questa pulizia ogni risposta ripete l'intero thread.
// Euristiche volutamente conservative: meglio lasciare un po' di rumore che tagliare contenuto.

const REPLY_HEADERS: RegExp[] = [
  /^On .{5,200}wrote:\s*$/i,
  /^Il giorno .{5,200}ha scritto:\s*$/i,
  /^Il .{5,200}ha scritto:\s*$/i,
  /^Le .{5,200}a écrit\s*:\s*$/i,
  /^Am .{5,200}schrieb .{0,100}:\s*$/i,
  /^El .{5,200}escribió:\s*$/i,
  /^-{2,}\s*(Original Message|Messaggio originale|Forwarded message|Messaggio inoltrato)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/, // separatore di Outlook
];

// Outlook: blocco "Da: ... / Inviato: ... / A: ... / Oggetto: ..." senza intestazione.
const OUTLOOK_FIELD = /^(From|Da|De|Von|Sent|Inviato|Date|Data|To|A|Subject|Oggetto)\s*:/i;

const SIGNATURE_MARKERS: RegExp[] = [
  /^-- ?$/, // delimitatore standard
  /^(Inviato|Sent) da (il mio )?(iPhone|iPad|Android|Outlook|Mail)\b/i,
  /^Sent from my (iPhone|iPad|Android|mobile)/i,
  /^Get Outlook for /i,
];

export function cleanBody(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Intestazione di risposta, eventualmente spezzata su due righe ("On ... \n ... wrote:").
    const joined = i + 1 < lines.length ? `${trimmed} ${lines[i + 1]!.trim()}` : trimmed;
    if (REPLY_HEADERS.some((r) => r.test(trimmed)) || REPLY_HEADERS.slice(0, 5).some((r) => r.test(joined))) break;

    if (OUTLOOK_FIELD.test(trimmed) && isOutlookHeaderBlock(lines, i)) break;
    if (SIGNATURE_MARKERS.some((r) => r.test(trimmed))) break;
    if (trimmed.startsWith('>')) continue;

    out.push(line);
  }

  return out
    .join('\n')
    // Segnaposto delle immagini nelle parti text/plain generate dai client ("[image: Logo]").
    .replace(/\[(image|immagine|cid):[^\]\n]*\]/gi, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isOutlookHeaderBlock(lines: string[], start: number): boolean {
  let fields = 0;
  for (let j = start; j < Math.min(lines.length, start + 6); j++) {
    if (OUTLOOK_FIELD.test(lines[j]!.trim())) fields++;
  }
  return fields >= 3;
}

export function makeSnippet(clean: string, max = 200): string {
  const flat = clean.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Oggetto senza prefissi di risposta/inoltro, per confronti e titoli di conversazione. */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').trim();
  const prefix = /^(re|r|fw|fwd|i|inoltra|aw|wg|tr|sv|vs)\s*(\[\d+\])?\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, '');
  return s.trim();
}
