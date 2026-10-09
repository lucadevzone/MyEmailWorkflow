import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMatch, useNavigate } from 'react-router-dom';
import { FolderPlus, Paperclip, Search as SearchIcon, SquareCheck, StickyNote } from 'lucide-react';
import type { SearchScope } from '@mmw/shared';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { PersonAvatar } from '../ui/People.tsx';
import { paths, projectKeyOf, SYSTEM_INBOX, SYSTEM_NEWS } from './paths.ts';

const SCOPE_KEY = 'mmw.search.scope';
const readScopePref = () => {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'current';
  } catch {
    return false;
  }
};

/** Evidenzia le parole cercate (senza distinguere maiuscole e accenti semplici). */
function highlight(text: string, terms: string[]): ReactNode {
  if (!terms.length || !text) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'giu');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

interface Hit {
  key: string;
  open: () => void;
  node: ReactNode;
}

/**
 * Ricerca unica (D14): il campo prende il posto della lente; sotto, il pannello dei risultati con
 * l'ambito (tutti i progetti / solo quello corrente), raggruppati in Conversazioni, Allegati e risorse, Task e note.
 */
export function SearchBox({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const match = useMatch('/p/:projectId/*');
  const current = match?.params.projectId ?? null;
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const currentName = current === SYSTEM_INBOX ? 'Da smistare' : current === SYSTEM_NEWS ? 'News' : projects.find((p) => p.id === current)?.name;
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [onlyCurrent, setOnlyCurrent] = useState(readScopePref);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 250);
    return () => window.clearTimeout(t);
  }, [text]);

  const scope: SearchScope = onlyCurrent && current ? (current === SYSTEM_INBOX ? 'inbox' : current === SYSTEM_NEWS ? 'news' : `project:${current}`) : 'all';
  const res = useQuery({
    queryKey: ['search', q, scope],
    queryFn: () => api.search(q, scope),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const data = q.length >= 2 ? res.data : undefined;

  const setScope = (only: boolean) => {
    setOnlyCurrent(only);
    setSel(0);
    try {
      localStorage.setItem(SCOPE_KEY, only ? 'current' : 'all');
    } catch {}
  };

  // Chiude con Esc o con un clic fuori dal campo e dal pannello.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  const projectLabel = (h: { projectId: string | null; isNoise: boolean }) =>
    h.projectId ? (projects.find((p) => p.id === h.projectId)?.name ?? 'Progetto') : h.isNoise ? 'News' : 'Da smistare';
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const where = (h: { conversationId: string | null; projectId: string | null; isNoise: boolean }) => {
    const key = projectKeyOf(h);
    return h.conversationId ? paths.conversation(key, h.conversationId) : paths.project(key);
  };

  const groups = useMemo(() => {
    if (!data) return [];
    const t = data.terms;
    const out: { title: string; hits: Hit[] }[] = [];
    if (data.conversations.length)
      out.push({
        title: 'Conversazioni',
        hits: data.conversations.map((c) => ({
          key: `c:${c.conversationId}`,
          open: () => go(where(c)),
          node: (
            <>
              <span className="pm-result__people">
                {(c.participants.length ? c.participants : [{ name: null, email: '?' }]).slice(0, 2).map((p) => (
                  <PersonAvatar key={p.email} person={p} size={26} />
                ))}
              </span>
              <span className="pm-result__main">
                <span className="pm-result__title">{highlight(c.title, t)}</span>
                <span className="pm-result__ctx">{highlight(c.snippet, t)}</span>
              </span>
              <span className="pm-projectlabel">{projectLabel(c)}</span>
            </>
          ),
        })),
      });
    if (data.files.length)
      out.push({
        title: 'Allegati e risorse',
        hits: data.files.map((f) => ({
          key: `f:${f.kind}:${f.id}`,
          open: () => go(where(f)),
          node: (
            <>
              <span className="pm-result__icon">
                <Ic icon={f.kind === 'resource' ? FolderPlus : Paperclip} size={17} />
              </span>
              <span className="pm-result__main">
                <span className="pm-result__title">{highlight(f.title, t)}</span>
                <span className="pm-result__ctx">{f.kind === 'resource' ? 'Risorsa' : 'Allegato'}{f.context ? ` · ${f.context}` : ''}</span>
              </span>
              <span className="pm-projectlabel">{projectLabel(f)}</span>
            </>
          ),
        })),
      });
    if (data.items.length)
      out.push({
        title: 'Task e note',
        hits: data.items.map((it) => ({
          key: `i:${it.kind}:${it.id}`,
          open: () => go(where(it)),
          node: (
            <>
              <span className={`pm-result__icon pm-result__icon--${it.kind}`}>
                <Ic icon={it.kind === 'task' ? SquareCheck : StickyNote} size={17} />
              </span>
              <span className="pm-result__main">
                <span className={`pm-result__title${it.done ? ' pm-result__title--done' : ''}`}>{highlight(it.title, t)}</span>
                {it.snippet && <span className="pm-result__ctx">{highlight(it.snippet, t)}</span>}
              </span>
              <span className="pm-projectlabel">{projectLabel(it)}</span>
            </>
          ),
        })),
      });
    return out;
  }, [data, projects]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = groups.flatMap((g) => g.hits);
  const total = flat.length;
  useEffect(() => setSel(0), [data]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' && total) {
      e.preventDefault();
      setSel((sel + 1) % total);
    } else if (e.key === 'ArrowUp' && total) {
      e.preventDefault();
      setSel((sel - 1 + total) % total);
    } else if (e.key === 'Enter' && flat[sel]) {
      e.preventDefault();
      flat[sel]!.open();
    }
  };

  let i = 0;
  return (
    <div className="pm-searchwrap" ref={box}>
      <label className="pm-search">
        <Ic icon={SearchIcon} size={17} />
        <input
          autoFocus
          role="combobox"
          aria-expanded={q.length >= 2}
          aria-controls="pm-results"
          aria-label="Cerca in conversazioni, allegati, task e note"
          placeholder={onlyCurrent && currentName ? `Cerca in ${currentName}…` : 'Cerca in tutti i progetti…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <kbd>Esc</kbd>
      </label>
      {q.length >= 2 && (
        <div className="pm-results" id="pm-results" role="listbox" aria-label="Risultati">
          <div className="pm-results__scope">
            <button type="button" className="pm-scope" aria-pressed={!onlyCurrent || !current} onClick={() => setScope(false)}>
              Tutti i progetti
            </button>
            {current && currentName && (
              <button type="button" className="pm-scope" aria-pressed={onlyCurrent} onClick={() => setScope(true)}>
                Solo {currentName}
              </button>
            )}
            <span className="pm-results__count">
              {res.isFetching && !data ? 'Cerco…' : `${total} ${total === 1 ? 'risultato' : 'risultati'}`}
            </span>
          </div>
          <div className="pm-results__list" ref={list}>
            {data && total === 0 && <div className="pm-results__empty">Nessun risultato per “{q}”.</div>}
            {groups.map((g) => (
              <div key={g.title} role="group" aria-label={g.title}>
                <div className="pm-results__group">{g.title}</div>
                {g.hits.map((h) => {
                  const idx = i++;
                  return (
                    <button
                      key={h.key}
                      type="button"
                      role="option"
                      className="pm-result"
                      aria-selected={idx === sel}
                      onMouseEnter={() => setSel(idx)}
                      onClick={h.open}
                    >
                      {h.node}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {data && !data.semantic && <div className="pm-results__hint">Ricerca per significato non disponibile (Ollama spento): solo parole esatte.</div>}
        </div>
      )}
    </div>
  );
}
