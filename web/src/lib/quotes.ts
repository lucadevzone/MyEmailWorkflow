// Riconoscimento del testo citato nell'HTML di un'email (risposte e inoltri dei client più diffusi).

/** Contenitori espliciti di citazione: Gmail, Apple Mail/Thunderbird, Yahoo, Outlook. */
const QUOTE_SELECTORS = [
  '.gmail_quote',
  '.gmail_extra',
  'blockquote[type="cite"]',
  '.moz-cite-prefix',
  '.yahoo_quoted',
  '#appendonsend',
  '[id^="divRplyFwdMsg"]',
  '.OutlookMessageHeader',
  '#mail-editor-reference-message-container',
];

/** Righe di intestazione di una citazione ("Il giorno … ha scritto:", "On … wrote:"). */
const ATTRIBUTION = /(ha scritto|wrote|a écrit|schrieb|escribió)\s*:?\s*$/i;
/** Inizio di un messaggio originale in stile Outlook. */
const ORIGINAL = /^\s*(-{2,}\s*(original message|messaggio originale|messaggio inoltrato|forwarded message)|(da|from)\s*:.+\n?.*(inviato|sent|data|date)\s*:)/i;

/**
 * Marca gli elementi citati con data-mmw-quote (senza toccare il resto) e dice se ne ha trovati.
 * Si marcano solo gli elementi più esterni: nascondendo quelli si nasconde tutto il loro contenuto.
 */
export function markQuotes(doc: Document): boolean {
  const body = doc.body;
  if (!body) return false;
  const marked = new Set<Element>();
  const mark = (el: Element | null) => {
    if (!el || el === body || el === doc.documentElement) return;
    for (const m of marked) if (m.contains(el)) return;
    for (const m of [...marked]) if (el.contains(m)) marked.delete(m);
    marked.add(el);
  };

  for (const el of body.querySelectorAll(QUOTE_SELECTORS.join(','))) mark(el);

  // Blockquote generici preceduti da una riga di attribuzione.
  for (const bq of body.querySelectorAll('blockquote')) {
    const prev = bq.previousElementSibling;
    if (prev && ATTRIBUTION.test(prev.textContent ?? '')) {
      mark(prev);
      mark(bq);
    }
  }

  // Outlook e simili: dal separatore "Messaggio originale" / "Da: … Inviato:" in poi, al suo livello.
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
    if (n.children.length > 3) continue;
    const text = (n as HTMLElement).innerText ?? n.textContent ?? '';
    if (text.length > 400 || !ORIGINAL.test(text)) continue;
    let target: Element = n;
    // Si risale finché l'elemento è l'unico figlio con testo: si nasconde il blocco intero.
    while (target.parentElement && target.parentElement !== body && target.parentElement.children.length === 1) target = target.parentElement;
    mark(target);
    for (let s = target.nextElementSibling; s; s = s.nextElementSibling) mark(s);
    break;
  }

  for (const el of marked) el.setAttribute('data-mmw-quote', '');
  return marked.size > 0;
}

/** Mostra o nasconde gli elementi marcati. */
export function setQuotesHidden(doc: Document, hidden: boolean) {
  let style = doc.getElementById('mmw-quotes');
  if (hidden && !style) {
    style = doc.createElement('style');
    style.id = 'mmw-quotes';
    style.textContent = '[data-mmw-quote]{display:none !important}';
    doc.head?.appendChild(style);
  } else if (!hidden && style) style.remove();
}
