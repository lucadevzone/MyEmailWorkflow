import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { PersonRef } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { PersonAvatar, PersonChip } from '../ui/People.tsx';
import { usePeopleSearch } from '../people/usePeopleSearch.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Riga di destinatari della bozza: chip-bolla rimovibili e una bolla tratteggiata "+" (D11). */
export function RecipientField({ label, value, onChange, autoFocus, extra }: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
  extra?: React.ReactNode;
}) {
  const { data: dir } = useQuery({ queryKey: ['directory'], queryFn: api.peopleDirectory, staleTime: 60_000 });
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(!!autoFocus);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const people = useMemo(() => {
    const out = new Map<string, PersonRef>();
    for (const p of [...(dir?.contacts ?? []), ...(dir?.suggested ?? [])]) for (const email of p.emails) if (!out.has(email)) out.set(email, { name: p.name, email });
    return out;
  }, [dir]);
  const q = text.trim().toLowerCase();
  // Prima la rubrica (contatti e più frequenti), poi il resto degli indirizzi visti.
  const found = usePeopleSearch(text);
  const matches = q
    ? [
        ...new Map(
          [
            ...[...people.values()].filter((p) => p.email.includes(q) || (p.name ?? '').toLowerCase().includes(q)),
            ...found.flatMap((p) => p.emails.map((email) => ({ name: p.name, email }))),
          ]
            .filter((p) => !value.includes(p.email))
            .map((p) => [p.email, p]),
        ).values(),
      ].slice(0, 6)
    : [];

  const add = (email: string) => {
    const e = email.trim().toLowerCase();
    if (e && !value.includes(e)) onChange([...value, e]);
    setText('');
    setSel(0);
  };
  const commit = () => {
    if (EMAIL.test(text.trim())) add(text);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setSel((sel + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setSel((sel - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && text.trim())) {
      if (matches[sel] && !EMAIL.test(text.trim())) {
        e.preventDefault();
        add(matches[sel]!.email);
      } else if (text.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape' && (text || editing)) {
      e.stopPropagation();
      setText('');
      setEditing(false);
    }
  };

  const showInput = editing || value.length === 0;
  return (
    <div className="pm-draft__row">
      <span className="pm-draft__label">{label}</span>
      {value.map((email) => (
        <PersonChip key={email} person={people.get(email) ?? { name: null, email }} onRemove={() => onChange(value.filter((v) => v !== email))} />
      ))}
      {showInput ? (
        <input
          ref={input}
          className="pm-draft__recipinput"
          aria-label={`Aggiungi destinatario (${label})`}
          placeholder={value.length ? '' : 'Nome o indirizzo email'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
          onBlur={() => {
            commit();
            setEditing(false);
          }}
          autoFocus={autoFocus || editing}
        />
      ) : (
        <button type="button" className="pm-draft__add" aria-label={`Aggiungi destinatario (${label})`} onClick={() => setEditing(true)}>
          <Ic icon={Plus} size={15} />
        </button>
      )}
      {extra && (
        <>
          <span style={{ flex: 1 }} />
          {extra}
        </>
      )}
      {showInput && matches.length > 0 && (
        <ul className="pm-draft__suggest" role="listbox">
          {matches.map((m, i) => (
            <li key={m.email}>
              <button
                type="button"
                role="option"
                aria-selected={i === sel}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(m.email);
                }}
              >
                <PersonAvatar person={m} size={24} />
                {m.name && <span style={{ fontWeight: 500 }}>{m.name}</span>}
                <span style={{ color: 'var(--ink-muted)' }}>{m.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
