import type { LucideIcon } from 'lucide-react';

/** Icona Lucide con il tratto della specifica: 18 px (standard) o 15 px (nei pulsanti). */
export function Ic({ icon: Icon, size = 18, className, label }: { icon: LucideIcon; size?: number; className?: string; label?: string }) {
  return (
    <Icon
      size={size}
      strokeWidth={size <= 15 ? 1.8 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      style={{ flex: 'none' }}
    />
  );
}
