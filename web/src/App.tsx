import { useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ProjectDto } from '@mmw/shared';
import { useServerEvents } from './events.ts';
import { TopBar } from './shell/TopBar.tsx';
import { StatusBar } from './shell/StatusBar.tsx';
import { paths, projectKeyOf, SYSTEM_INBOX } from './shell/paths.ts';
import { ProjectPage } from './project/ProjectPage.tsx';
import { PeoplePage } from './people/PeoplePage.tsx';
import { ActivitiesPage } from './activities/ActivitiesPage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';
import { ProjectDialog } from './projects/ProjectDialog.tsx';

export function App() {
  useServerEvents();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | { project?: ProjectDto }>(null);

  return (
    <div className="pm-app">
      <TopBar onNewProject={() => setDialog({})} onEditProject={(p) => setDialog({ project: p })} />
      <main className="pm-content">
        <Routes>
          <Route path="/" element={<Navigate to={paths.project(SYSTEM_INBOX)} replace />} />
          <Route path="/p/:projectId" element={<ProjectRoute onEditProject={(p) => setDialog({ project: p })} />} />
          <Route path="/p/:projectId/c/:conversationId" element={<ProjectRoute onEditProject={(p) => setDialog({ project: p })} />} />
          <Route path="/p/:projectId/c/:conversationId/m/:messageId" element={<ProjectRoute onEditProject={(p) => setDialog({ project: p })} />} />
          <Route path="/contacts" element={<ContactsRoute />} />
          <Route path="/activities" element={<div className="h-full overflow-y-auto"><ActivitiesPage /></div>} />
          <Route path="/settings" element={<div className="h-full overflow-y-auto"><SettingsPage /></div>} />
          <Route path="*" element={<Navigate to={paths.project(SYSTEM_INBOX)} replace />} />
        </Routes>
      </main>
      <StatusBar />
      {dialog && (
        <ProjectDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onSaved={(p) => {
            if (!dialog.project) navigate(paths.project(p.id));
          }}
        />
      )}
    </div>
  );
}

/** S1 · Progetto (con conversazione in focus e, per ora, messaggio in un pannello). */
function ProjectRoute({ onEditProject }: { onEditProject: (p: ProjectDto) => void }) {
  const { projectId = SYSTEM_INBOX, conversationId, messageId } = useParams();
  return <ProjectPage key={projectId} projectKey={projectId} conversationId={conversationId ?? null} messageId={messageId ?? null} onEditProject={onEditProject} />;
}

function ContactsRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return <PeoplePage focusKey={params.get('focus')} onOpenConversation={(c) => navigate(paths.conversation(projectKeyOf(c), c.id))} />;
}
