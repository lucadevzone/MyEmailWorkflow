// Chiave stabile di un messaggio, uguale su tutti i PC (uso alternato, docs/03-uso-su-piu-pc.md):
// account + Message-ID; se manca, l'identificativo Gmail. Deve coincidere con il backfill della
// migrazione 0022.

export function stableKeyOf(accountId: string, rfcMessageId: string | null, gmMsgid: string | null, id: string): string {
  return `${accountId}|${rfcMessageId ?? (gmMsgid ? `gm:${gmMsgid}` : `id:${id}`)}`;
}
