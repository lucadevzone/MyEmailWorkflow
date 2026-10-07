import type { PersonRef } from '@mmw/shared';

const time = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
const long = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function shortDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time.format(d);
  if (d.getFullYear() === today.getFullYear()) return dayMonth.format(d);
  return full.format(d);
}

export const longDate = (ts: number) => long.format(new Date(ts));

export function personLabel(p: PersonRef): string {
  return p.name || p.email.split('@')[0]!;
}

export function initials(p: PersonRef): string {
  const base = p.name || p.email;
  const parts = base.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase();
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const PALETTE = ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#65a30d', '#dc2626'];

/** Colore stabile derivato da una stringa (per account e avatar senza colore esplicito). */
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}
