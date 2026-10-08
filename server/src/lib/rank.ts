// Indici frazionari per l'ordinamento manuale (coda dei task): tra due chiavi ne esiste sempre
// una intermedia, quindi spostare un elemento modifica una sola riga.
// Le chiavi sono stringhe base 36 confrontate in ordine lessicografico; non finiscono mai con "0".

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

/** Chiave strettamente compresa tra a e b (null = estremo aperto). */
export function rankBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`Chiavi non ordinate: ${a} >= ${b}`);
  const lo = a ?? '';
  let hi = b;
  let out = '';
  for (let i = 0; ; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const db = hi !== null && i < hi.length ? DIGITS.indexOf(hi[i]!) : BASE;
    if (da === db) {
      out += DIGITS[da];
      continue;
    }
    if (db - da > 1) return out + DIGITS[Math.floor((da + db) / 2)];
    // Cifre adiacenti: si prende quella bassa e da qui in poi il limite superiore è libero.
    out += DIGITS[da];
    hi = null;
  }
}
