// Ritrovare nel testo di un messaggio il brano annotato (TextQuoteSelector: esatto + prima/dopo).

import type { QuoteSelector } from '@mmw/shared';

const CONTEXT = 32;
const norm = (s: string) => s.replace(/\s+/g, ' ');

/** Posizione del brano in un testo: tra le occorrenze dell'esatto, quella col contesto più simile. */
export function findQuote(text: string, q: QuoteSelector): number {
  const hits: number[] = [];
  for (let i = text.indexOf(q.exact); i >= 0; i = text.indexOf(q.exact, i + 1)) hits.push(i);
  if (hits.length <= 1) return hits[0] ?? -1;
  const pre = norm(q.prefix ?? '');
  const suf = norm(q.suffix ?? '');
  let best = hits[0]!;
  let bestScore = -1;
  for (const i of hits) {
    const before = norm(text.slice(Math.max(0, i - CONTEXT * 2), i));
    const after = norm(text.slice(i + q.exact.length, i + q.exact.length + CONTEXT * 2));
    const score = (pre && before.endsWith(pre.trim()) ? 2 : 0) + (suf && after.startsWith(suf.trim()) ? 1 : 0);
    if (score > bestScore) [best, bestScore] = [i, score];
  }
  return best;
}

/** Nodi di testo di un elemento, con l'inizio di ciascuno nel testo complessivo. */
function textIndex(root: Node) {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  return { nodes, text };
}

/** Range DOM del brano dentro un elemento, o null se non si trova. */
export function locateRange(root: Node, q: QuoteSelector): Range | null {
  const { nodes, text } = textIndex(root);
  const at = findQuote(text, q);
  if (at < 0) return null;
  const end = at + q.exact.length;
  const doc = root.ownerDocument ?? (root as Document);
  const range = doc.createRange();
  const pos = (offset: number) => {
    for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i]!.start <= offset) return { node: nodes[i]!.node, off: offset - nodes[i]!.start };
    return null;
  };
  const s = pos(at);
  const e = pos(end);
  if (!s || !e) return null;
  range.setStart(s.node, Math.min(s.off, s.node.length));
  range.setEnd(e.node, Math.min(e.off, e.node.length));
  return range;
}

/** Contesto (testo prima e dopo) di una selezione dentro un elemento, per ritrovarla in seguito. */
export function quoteOf(root: Node, range: Range): QuoteSelector {
  const doc = root.ownerDocument ?? (root as Document);
  const before = doc.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = doc.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(root, root.childNodes.length);
  return { exact: range.toString(), prefix: before.toString().slice(-CONTEXT), suffix: after.toString().slice(0, CONTEXT) };
}
