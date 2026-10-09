import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, X } from 'lucide-react';
import type { PersonRef } from '@mmw/shared';
import { api } from '../api.ts';
import { avatarColor, initials, personLabel } from '../lib/format.ts';
import { Ic } from './Ic.tsx';

type Size = 18 | 20 | 22 | 24 | 26 | 30 | 40 | 44 | 72;

/** Foto dei contatti e indirizzi propri (per mostrare "Io"), dalla cache delle query. */
export function usePeopleIndex() {
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory, staleTime: 60_000 });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts, staleTime: 60_000 });
  return useMemo(() => {
    const photos = new Map<string, string>();
    for (const p of dir?.contacts ?? []) if (p.avatarUrl) for (const e of p.emails) photos.set(e, p.avatarUrl);
    const own = new Set(accounts.map((a) => a.email.toLowerCase()));
    return { photo: (email: string) => photos.get(email.toLowerCase()) ?? null, isMe: (email: string) => own.has(email.toLowerCase()) };
  }, [dir, accounts]);
}

/** Cerchio = sempre una persona (D4). L'utente compare come "Io". */
export function PersonAvatar({ person, size = 26, avatarUrl }: { person: PersonRef; size?: Size; avatarUrl?: string | null }) {
  const idx = usePeopleIndex();
  const src = avatarUrl ?? idx.photo(person.email);
  const cls = `pm-avatar pm-avatar--${size}`;
  if (src) return <img className={cls} src={src} alt="" />;
  return (
    <span className={cls} style={{ background: avatarColor(person.email) }} aria-hidden="true">
      {initials(person)}
    </span>
  );
}

/** Nome da mostrare accanto alla bolla: "Io" per i propri indirizzi. */
export function useDisplayName() {
  const idx = usePeopleIndex();
  return (p: PersonRef) => (idx.isMe(p.email) ? 'Io' : personLabel(p));
}

/** Quadrato arrotondato = sempre un gruppo. "Tutti" ha fondo inchiostro; gli altri mostrano fino a 3 membri. */
export function GroupBadge({ members, all = false, size = 48 }: { members?: PersonRef[]; all?: boolean; size?: 30 | 42 | 48 }) {
  if (all) {
    return (
      <span className={`pm-group pm-group--all pm-group--${size}`} aria-hidden="true">
        <Ic icon={Users} size={size >= 42 ? 18 : 15} />
      </span>
    );
  }
  const shown = (members ?? []).slice(0, 3);
  return (
    <span className={`pm-group pm-group--user pm-group--${size}`} aria-hidden="true">
      <span style={{ display: 'flex' }}>
        {shown.map((m) => (
          <PersonAvatar key={m.email} person={m} size={size >= 42 ? 20 : 18} />
        ))}
      </span>
    </span>
  );
}

/** L'utente come persona ("Io"): nome e indirizzo del primo account. */
export function useMe(): PersonRef | null {
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts, staleTime: 60_000 });
  return accounts[0] ? { name: accounts[0].name, email: accounts[0].email } : null;
}

/** Avatar sovrapposti + nomi separati da virgola (conversazioni compresse). L'utente chiude l'elenco come "Io". */
export function PeopleLine({ people: others, max = 4 }: { people: PersonRef[]; max?: number }) {
  const name = useDisplayName();
  const me = useMe();
  const people = me ? [...others, me] : others;
  return (
    <span className="pm-conv__people">
      <span className="pm-stack">
        {people.slice(0, max).map((p) => (
          <PersonAvatar key={p.email} person={p} size={22} />
        ))}
      </span>
      <span className="pm-truncate">{people.map(name).join(', ')}</span>
    </span>
  );
}

/** Bolla + nome in una pillola; con onRemove diventa rimovibile. */
export function PersonChip({ person, onRemove, onClick }: { person: PersonRef; onRemove?: () => void; onClick?: () => void }) {
  const name = useDisplayName();
  const body = (
    <>
      <PersonAvatar person={person} size={22} />
      <span className="pm-truncate">{name(person)}</span>
    </>
  );
  return (
    <span className={`pm-personchip${onRemove ? ' pm-personchip--removable' : ''}`} title={person.email}>
      {onClick ? (
        <button type="button" onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, background: 'transparent', padding: 0, minWidth: 0 }}>
          {body}
        </button>
      ) : (
        body
      )}
      {onRemove && (
        <button type="button" className="pm-personchip__remove" onClick={onRemove} aria-label={`Rimuovi ${name(person)}`}>
          <Ic icon={X} size={15} />
        </button>
      )}
    </span>
  );
}
