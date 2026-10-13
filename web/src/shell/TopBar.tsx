import { useQuery } from '@tanstack/react-query';
import { NavLink, useMatch } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { PanelLeft, Search, SlidersHorizontal, Users } from 'lucide-react';
import { SearchBox } from './Search.tsx';
import { StatusMenu } from './StatusMenu.tsx';
import { api } from '../api.ts';
import { Ic } from '../ui/Ic.tsx';
import { paths, SYSTEM_INBOX, SYSTEM_NEWS, SYSTEM_SPAM } from './paths.ts';

/**
 * Barra superiore (UI v2): apre/chiude la barra dei progetti, Cerca, il nome del progetto corrente;
 * a destra Contatti, Impostazioni e Stato. Nelle viste Email e Composizione il titolo non c'è: il percorso
 * sta nella barra di contesto.
 */
export function TopBar({ sidebarOpen, onToggleSidebar, showTitle }: { sidebarOpen: boolean; onToggleSidebar: () => void; showTitle: boolean }) {
  const [searching, setSearching] = useState(false);
  const title = useProjectTitle();

  useEffect(() => {
    document.title = title ? `${title} · Posta per progetti` : 'Posta per progetti';
  }, [title]);

  // "/" apre la ricerca da qualunque punto (tranne mentre si scrive).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      setSearching(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className={`pm-topbar${searching ? ' pm-topbar--searching' : ''}`}>
      <button
        type="button"
        className="pm-iconbtn"
        aria-label={sidebarOpen ? 'Chiudi la barra dei progetti' : 'Apri la barra dei progetti'}
        title="Barra dei progetti"
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <Ic icon={PanelLeft} />
      </button>
      {searching ? (
        <SearchBox onClose={() => setSearching(false)} />
      ) : (
        <button type="button" className="pm-iconbtn" aria-label="Cerca in tutti i progetti" title="Cerca (/)" onClick={() => setSearching(true)}>
          <Ic icon={Search} />
        </button>
      )}
      {!searching && showTitle && title && (
        <>
          <span className="pm-topbar__sep" aria-hidden="true" />
          <h1 className="pm-topbar__title">{title}</h1>
        </>
      )}
      <span className="pm-spacer" />
      <div className="pm-topbar__tools">
        <NavLink to={paths.contacts()} className="pm-iconbtn" aria-label="Contatti e gruppi" title="Contatti e gruppi">
          <Ic icon={Users} />
        </NavLink>
        <NavLink to={paths.settings()} className="pm-iconbtn" aria-label="Impostazioni" title="Impostazioni">
          <Ic icon={SlidersHorizontal} />
        </NavLink>
        <StatusMenu />
      </div>
    </header>
  );
}

/** Nome del progetto (o della vista di sistema) della pagina corrente. */
function useProjectTitle(): string | null {
  const match = useMatch('/p/:projectId/*');
  const id = match?.params.projectId;
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  if (!id) return null;
  if (id === SYSTEM_INBOX) return 'Da smistare';
  if (id === SYSTEM_NEWS) return 'News';
  if (id === SYSTEM_SPAM) return 'Spam';
  return projects.find((p) => p.id === id)?.name ?? null;
}
