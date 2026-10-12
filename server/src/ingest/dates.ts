// Data di un messaggio: quella scritta nella mail si può falsificare (lo spam usa date come l'anno 8496).
// Se è assurda si usa la data di arrivo registrata dal server (INTERNALDATE o l'intestazione Received).

const MIN = Date.UTC(1995, 0, 1);
const SLACK = 2 * 86_400_000;

const plausible = (d: Date | null | undefined): d is Date => !!d && !Number.isNaN(d.getTime()) && d.getTime() >= MIN && d.getTime() <= Date.now() + SLACK;

/** Data dall'ultima intestazione Received aggiunta (la prima in cima): "…; Tue, 7 Oct 2026 10:00:00 +0200". */
export function receivedDate(headers: Map<string, unknown>): Date | null {
  const raw = headers.get('received');
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return null;
  const at = first.lastIndexOf(';');
  if (at < 0) return null;
  const d = new Date(first.slice(at + 1).trim());
  return plausible(d) ? d : null;
}

/** La data da usare per il messaggio, e se quella scritta nella mail era falsa. */
export function messageDate(written: Date | null | undefined, internal: Date | null | undefined, headers: Map<string, unknown>): { date: number; forged: boolean } {
  const hasDate = !!written && !Number.isNaN(written.getTime());
  if (plausible(written)) return { date: written.getTime(), forged: false };
  const fallback = plausible(internal) ? internal : (receivedDate(headers) ?? new Date());
  return { date: fallback.getTime(), forged: hasDate };
}
