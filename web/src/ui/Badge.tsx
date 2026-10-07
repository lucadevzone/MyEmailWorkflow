/** Badge numerico: azzurro (da leggere in una sezione), rosso (totale / conversazione), blu (messaggio). */
export function Badge({ n, tone }: { n?: number; tone: 'sky' | 'red' | 'blue' }) {
  if (!n) return null;
  const cls = {
    sky: 'bg-sky-400 text-white',
    red: 'bg-rose-600 text-white',
    blue: 'bg-blue-600 text-white',
  }[tone];
  return (
    <span className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${cls}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
