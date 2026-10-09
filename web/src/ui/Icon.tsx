/** Icona Material Symbols (self-hosted). */
export function Icon({ name, className = '', size = 20, title }: { name: string; className?: string; size?: number; title?: string }) {
  return (
    <span className={`material-symbols-outlined pm-msym ${className}`} style={{ fontSize: size }} title={title} aria-hidden={!title}>
      {name}
    </span>
  );
}
