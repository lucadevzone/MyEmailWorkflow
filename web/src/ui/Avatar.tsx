import { colorFor, initials } from '../lib/format.ts';

/** Bolla di una persona: iniziali su colore stabile derivato dall'indirizzo. */
export function Avatar({ name, email, size = 32, ring = false }: { name: string | null; email: string; size?: number; ring?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${ring ? 'ring-2 ring-offset-2 ring-stone-900 dark:ring-stone-100 dark:ring-offset-stone-950' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.38, background: colorFor(email) }}
    >
      {initials({ name, email })}
    </span>
  );
}
