// Gruppi per data della lista delle conversazioni: Oggi, Ieri, Questa settimana, Questo mese, poi i mesi
// dell'anno in corso uno per uno, poi gli anni interi. Ci si ricorda di una mail come "era di settembre"
// o "era dell'anno scorso", non come "negli ultimi 6 mesi".

export interface DateGroup {
  /** Chiave stabile (per ricordare i gruppi chiusi): today, yesterday, week, month, m-2026-09, y-2025. */
  key: string;
  label: string;
}

const MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function dateGroupOf(ts: number, now = new Date()): DateGroup {
  const today = startOfDay(now);
  const day = 86_400_000;
  if (ts >= today) return { key: 'today', label: 'Oggi' };
  if (ts >= today - day) return { key: 'yesterday', label: 'Ieri' };
  // La settimana comincia il lunedì.
  const weekStart = today - ((now.getDay() + 6) % 7) * day;
  if (ts >= weekStart) return { key: 'week', label: 'Questa settimana' };
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (ts >= monthStart) return { key: 'month', label: 'Questo mese' };
  const d = new Date(ts);
  if (d.getFullYear() === now.getFullYear()) {
    return { key: `m-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: MONTHS[d.getMonth()]! };
  }
  return { key: `y-${d.getFullYear()}`, label: String(d.getFullYear()) };
}

/** Raggruppa elementi già ordinati dal più recente, mantenendo l'ordine. */
export function groupByDate<T>(items: T[], tsOf: (item: T) => number, now = new Date()): { group: DateGroup; items: T[] }[] {
  const out: { group: DateGroup; items: T[] }[] = [];
  for (const item of items) {
    const g = dateGroupOf(tsOf(item), now);
    const last = out[out.length - 1];
    if (last && last.group.key === g.key) last.items.push(item);
    else out.push({ group: g, items: [item] });
  }
  return out;
}

const COLLAPSED_KEY = 'mmw.groups.collapsed';

export function readCollapsedGroups(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(keys: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* solo una comodità */
  }
}
