import { useState } from 'react';
import { SettingsPage } from './settings/SettingsPage.tsx';

// Le sezioni arrivano con le milestone successive (docs/02-system-design.md §9).
const SECTIONS = [
  { id: 'inbox', label: 'Da smistare', milestone: 'M1' },
  { id: 'projects', label: 'Progetti', milestone: 'M2' },
  { id: 'people', label: 'Persone', milestone: 'M3' },
  { id: 'tasks', label: 'Task', milestone: 'M4' },
  { id: 'activities', label: 'Attività', milestone: 'M2' },
  { id: 'noise', label: 'Rumore', milestone: 'M1' },
] as const;

export function App() {
  const [section, setSection] = useState<string>('settings');

  return (
    <div className="flex h-full">
      <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-stone-200 p-3 dark:border-stone-800">
        <div className="mb-4 px-2 text-sm font-semibold tracking-tight">my mail workflow</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            disabled
            title={`Disponibile da ${s.milestone}`}
            className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-stone-400 dark:text-stone-600"
          >
            {s.label}
            <span className="text-[10px] uppercase">{s.milestone}</span>
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setSection('settings')}
          className={`rounded-md px-2 py-1.5 text-left text-sm ${
            section === 'settings' ? 'bg-stone-200 font-medium dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-900'
          }`}
        >
          Impostazioni
        </button>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">{section === 'settings' && <SettingsPage />}</main>
    </div>
  );
}
