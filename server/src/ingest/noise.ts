// Riconoscimento euristico di newsletter e notifiche automatiche.
// È un primo filtro: l'utente può sempre correggere, e da M4 l'LLM decide nei casi dubbi.

export interface NoiseSignals {
  /** Header come li espone mailparser: i List-* sono raggruppati sotto la chiave "list". */
  headers: Map<string, unknown>;
  fromAddress: string | null;
}

/** "noreply" ovunque nella parte locale (google-noreply@, no-reply@, donotreply@…). */
const NOREPLY = /(^|[._+-])(no-?reply|do-?not-?reply|noreply)([._+-]|@)/i;
const AUTOMATED_LOCAL = /^(notifications?|notifiche|newsletter|news|mailer-daemon|bounce[s]?|alerts?|marketing|updates?)([+._-].*)?@/i;

/** Header aggiunti dalle piattaforme di invio massivo (SendGrid, Mailchimp, SES, Mailgun, Gmail FBL…). */
const BULK_HEADERS = ['feedback-id', 'x-sg-eid', 'x-mc-user', 'x-mailgun-sid', 'x-ses-outgoing', 'x-campaign', 'x-campaignid'];

export function detectNoise({ headers, fromAddress }: NoiseSignals): { isNoise: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const text = (name: string) => {
    const v = headers.get(name);
    if (v == null) return '';
    if (typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value).toLowerCase();
    return String(v).toLowerCase();
  };

  const list = (headers.get('list') ?? {}) as Record<string, unknown>;
  if (list.unsubscribe || headers.has('list-unsubscribe')) reasons.push('list-unsubscribe');
  if (list.id || headers.has('list-id')) reasons.push('list-id');
  if (/^(bulk|list|junk)$/.test(text('precedence'))) reasons.push(`precedence:${text('precedence')}`);
  const auto = text('auto-submitted');
  if (auto && auto !== 'no') reasons.push(`auto-submitted:${auto}`);
  for (const h of BULK_HEADERS) if (headers.has(h)) reasons.push(h);
  if (fromAddress && (NOREPLY.test(fromAddress) || AUTOMATED_LOCAL.test(fromAddress))) reasons.push('mittente automatico');

  // Una mailing list di discussione ha list-id ma è posta "vera": serve almeno un altro segnale.
  const strong = reasons.filter((r) => r !== 'list-id');
  return { isNoise: strong.length > 0, reasons };
}
