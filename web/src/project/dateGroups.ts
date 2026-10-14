// Gruppi aperti della lista delle conversazioni, ricordati nel browser (per tutte le viste).
// Il calcolo dei gruppi per data sta in @mmw/shared (dateGroupOf), uguale per server e interfaccia.

const OPEN_KEY = 'mmw.groups.open';

export function readOpenGroups(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function writeOpenGroups(state: Record<string, boolean>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(state));
  } catch {
    /* solo una comodità */
  }
}
