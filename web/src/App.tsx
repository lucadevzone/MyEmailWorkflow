import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProjectDto } from '@mmw/shared';
import { api } from './api.ts';
import { useServerEvents } from './events.ts';
import { TopBar } from './shell/TopBar.tsx';
import { StatusBar } from './shell/StatusBar.tsx';
import type { Nav } from './shell/nav.ts';
import { WorkspacePage, type WorkspaceScope } from './workspace/WorkspacePage.tsx';
import { PeoplePage } from './people/PeoplePage.tsx';
import { ActivitiesPage } from './activities/ActivitiesPage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';
import { ProjectDialog } from './projects/ProjectDialog.tsx';

export function App() {
  useServerEvents();
  const [nav, setNav] = useState<Nav>({ kind: 'inbox' });
  const [dialog, setDialog] = useState<null | { project?: ProjectDto }>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const go = (n: Nav) => {
    setFocus(null);
    setNav(n);
  };
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const scope: WorkspaceScope | null =
    nav.kind === 'inbox' ? { view: 'inbox' } : nav.kind === 'noise' ? { view: 'noise' } : nav.kind === 'project' ? { view: 'project', projectId: nav.projectId } : null;
  const project = nav.kind === 'project' ? projects.find((p) => p.id === nav.projectId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <TopBar nav={nav} onNav={go} onNewProject={() => setDialog({})} />
      <main className="min-h-0 flex-1 overflow-hidden">
        {scope && <WorkspacePage key={JSON.stringify(scope)} scope={scope} focusConversationId={focus} onEditProject={() => project && setDialog({ project })} />}
        {nav.kind === 'people' && (
          <PeoplePage
            onOpenConversation={(c) => {
              setNav(c.projectId ? { kind: 'project', projectId: c.projectId } : c.isNoise ? { kind: 'noise' } : { kind: 'inbox' });
              setFocus(c.id);
            }}
          />
        )}
        {nav.kind === 'activities' && (
          <div className="h-full overflow-y-auto">
            <ActivitiesPage />
          </div>
        )}
        {nav.kind === 'settings' && (
          <div className="h-full overflow-y-auto">
            <SettingsPage />
          </div>
        )}
      </main>
      <StatusBar nav={nav} onNav={go} />
      {dialog && (
        <ProjectDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onSaved={(p) => {
            if (!dialog.project) go({ kind: 'project', projectId: p.id });
          }}
        />
      )}
    </div>
  );
}
