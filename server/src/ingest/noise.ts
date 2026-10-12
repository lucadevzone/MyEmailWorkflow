// Riconoscimento euristico di newsletter e notifiche automatiche.
// È un primo filtro: l'utente può sempre correggere, e da M4 l'LLM decide nei casi dubbi.

export interface NoiseSignals {
  /** Header come li espone mailparser: i List-* sono raggruppati sotto la chiave "list". */
  headers: Map<string, unknown>;
  fromAddress: string | null;
  /** Oggetto: le parole da mail transazionale (fattura, avviso di pagamento…) tengono fuori dalle News. */
  subject?: string | null;
}

/** "noreply" ovunque nella parte locale (google-noreply@, no-reply@, donotreply@…). */
const NOREPLY = /(^|[._+-])(no-?reply|do-?not-?reply|noreply)([._+-]|@)/i;
/** Mittenti di sistema (notifiche, rimbalzi): indizio debole, li usano anche le mail transazionali. */
const SYSTEM_LOCAL = /^(notifications?|notifiche|alerts?|updates?|mailer-daemon|bounce[s]?)([+._-].*)?@/i;
/** Mittenti di marketing: indizio forte. */
const MARKETING_LOCAL = /^(newsletter|news|marketing|promo(zioni)?|offerte|deals)([+._-].*)?@/i;

/** Header delle piattaforme di invio massivo: le usano anche fatture e notifiche vere, quindi indizi deboli. */
const BULK_HEADERS = ['feedback-id', 'x-feedback-id', 'x-sg-eid', 'x-mailgun-sid', 'x-ses-outgoing'];
/** Tracciamento delle aperture o dei clic: tipico delle comunicazioni promozionali (indizio debole). */
const TRACKING_HEADERS = ['x-mailgun-track-opens', 'x-mailgun-track-clicks', 'x-mailgun-tag', 'x-mc-tracking'];
/** Domini di invio massivo: newsletter.x.it, updates.x.io, e.x.com… (indizio debole). */
const BULK_DOMAIN = /@(newsletter|news|updates?|mail(ing)?|e?mail|marketing|promo|em|e|info)\./i;
/** Header delle campagne di marketing: indizi forti. */
const CAMPAIGN_HEADERS = ['x-mc-user', 'x-campaign', 'x-campaignid'];

/** Oggetti da mail transazionale: una fattura o un avviso di pagamento non sono una newsletter. */
const TRANSACTIONAL = new RegExp(
  [
    'fattur', 'avviso di pagamento', 'estratto conto', 'ricevut', 'pagament', 'bollett', 'addebit', 'scadenz', 'rata',
    'ordine', 'spedizion', 'consegn', 'prenotazion', 'conferm', 'bigliett', 'appuntament', 'nuovo messaggio', 'ti ha scritto',
    'invoice', 'receipt', 'payment', 'order', 'shipping', 'delivery', 'booking', 'reservation', 'confirm', 'ticket', 'new message',
  ].join('|'),
  'i',
);

/**
 * Newsletter e notifiche automatiche: indizi forti (liste di distribuzione, invii "bulk", campagne,
 * mittenti di marketing) e deboli (header delle piattaforme di invio, noreply, List-Unsubscribe da solo).
 * Rumore = almeno un indizio forte, oppure due deboli di cui almeno uno promozionale; se l'oggetto è
 * transazionale servono indizi forti.
 */
export function detectNoise({ headers, fromAddress, subject }: NoiseSignals): { isNoise: boolean; reasons: string[] } {
  const strong: string[] = [];
  const weak: string[] = [];
  // Tra i deboli, quelli promozionali (disiscrizione, tracciamento, dominio di invio massivo) distinguono una
  // newsletter da una notifica di servizio (ricevute, documenti, avvisi), che spesso ha solo noreply + piattaforma.
  const promo: string[] = [];
  const text = (name: string) => {
    const v = headers.get(name);
    if (v == null) return '';
    if (typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value).toLowerCase();
    return String(v).toLowerCase();
  };

  const list = (headers.get('list') ?? {}) as Record<string, unknown>;
  const unsubscribe = !!list.unsubscribe || headers.has('list-unsubscribe');
  const listId = !!list.id || headers.has('list-id');
  // Una mailing list con il link per disiscriversi è un invio a lista; List-ID da solo può essere una lista di discussione.
  if (listId && unsubscribe) strong.push('mailing list');
  else if (unsubscribe) promo.push('list-unsubscribe');
  if (/^(bulk|list|junk)$/.test(text('precedence'))) strong.push(`precedence:${text('precedence')}`);
  for (const h of CAMPAIGN_HEADERS) if (headers.has(h)) strong.push(h);
  for (const h of BULK_HEADERS) if (headers.has(h)) weak.push(h);
  if (TRACKING_HEADERS.some((h) => headers.has(h))) promo.push('tracciamento aperture');
  if (fromAddress && BULK_DOMAIN.test(fromAddress)) promo.push('dominio di invio massivo');
  const auto = text('auto-submitted');
  if (auto && auto !== 'no') weak.push(`auto-submitted:${auto}`);
  if (fromAddress && MARKETING_LOCAL.test(fromAddress)) strong.push('mittente di marketing');
  else if (fromAddress && (NOREPLY.test(fromAddress) || SYSTEM_LOCAL.test(fromAddress))) weak.push('mittente automatico');

  const transactional = !!subject && TRANSACTIONAL.test(subject);
  const isNoise = transactional ? strong.length > 0 : strong.length > 0 || (promo.length > 0 && promo.length + weak.length >= 2);
  return { isNoise, reasons: [...strong, ...promo, ...weak, ...(transactional ? ['oggetto transazionale'] : [])] };
}
