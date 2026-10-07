// Preparazione dell'HTML di un'email per la visualizzazione in un iframe sandbox.
// - Le immagini inline (cid:) puntano agli allegati locali.
// - Le immagini remote sono bloccate dalla CSP salvo richiesta esplicita (tracking pixel).
// - I link si aprono in una nuova finestra.

export function prepareHtml(html: string, cidMap: Map<string, string>): string {
  const withCid = html.replace(/(["'(])cid:([^"')\s]+)/gi, (match, q: string, cid: string) => {
    const url = cidMap.get(cid.replace(/^<|>$/g, ''));
    return url ? `${q}${url}` : match;
  });
  const head =
    '<meta charset="utf-8"><base target="_blank">' +
    '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;word-wrap:break-word}img{max-width:100%;height:auto}</style>';
  return /<head[^>]*>/i.test(withCid) ? withCid.replace(/<head[^>]*>/i, (m) => m + head) : head + withCid;
}

export function htmlCsp(allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? "img-src 'self' data: https: http:" : "img-src 'self' data:";
  return ["default-src 'none'", img, "style-src 'unsafe-inline'", "font-src 'self' data:"].join('; ');
}
