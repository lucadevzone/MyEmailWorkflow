import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { colorFor, initials } from '../lib/format.ts';

/** Mappa email → foto dei contatti (dalla rubrica, già in cache). */
function useAvatarIndex() {
  const { data } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory, staleTime: 60_000 });
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const p of data?.contacts ?? []) if (p.avatarUrl) for (const e of p.emails) m.set(e, p.avatarUrl);
    return m;
  }, [data]);
}

/** Bolla di una persona: la foto se c'è, altrimenti le iniziali su un colore stabile. */
export function Avatar({ name, email, avatarUrl, size = 32, ring = false }: {
  name: string | null;
  email: string;
  avatarUrl?: string | null;
  size?: number;
  ring?: boolean;
}) {
  const index = useAvatarIndex();
  const src = avatarUrl ?? index.get(email.toLowerCase()) ?? null;
  const ringCls = ring ? 'ring-2 ring-offset-2 ring-stone-900 dark:ring-stone-100 dark:ring-offset-stone-950' : '';
  if (src) {
    return <img src={src} alt={name ?? email} className={`shrink-0 rounded-full object-cover ${ringCls}`} style={{ width: size, height: size }} />;
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${ringCls}`}
      style={{ width: size, height: size, fontSize: size * 0.38, background: colorFor(email) }}
    >
      {initials({ name, email })}
    </span>
  );
}

/** Ritaglio quadrato al centro e ridimensionamento a 256 px, in JPEG: la foto pesa pochi KB. */
export async function prepareAvatar(file: File, side = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const crop = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversione immagine fallita'))), 'image/jpeg', 0.88),
  );
}
