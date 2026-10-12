import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ProjectDto } from '@mmw/shared';
import { useServerEvents } from './events.ts';
import { TopBar } from './shell/TopBar.tsx';
import { StatusBar } from './shell/StatusBar.tsx';
import { paths, projectKeyOf, SYSTEM_INBOX } from './shell/paths.ts';
import { ProjectPage } from './project/ProjectPage.tsx';
import { ContactsPage } from './people/ContactsPage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';
import { ProjectSettingsPage } from './projects/ProjectSettingsPage.tsx';
import { WelcomePage } from './welcome/WelcomePage.tsx';
import { SenderRuleHost } from './rules/SenderRuleDialog.tsx';
import { RelatedMoveHost } from './rules/RelatedMoveDialog.tsx';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { EditingDimmer, useEditing } from './ui/editing.tsx';

export function App() {
  useServerEvents();
  const navigate = useNavigate();
  const editProject = (p: ProjectDto) => navigate(paths.projectSettings(p.id));

  const editing = useEditing();
  const { pathname } = useLocation();
  // Nella vista email (lettura e scrittura) la barra dei progetti lascia il posto alla barra di contesto.
  const mailMode = /^\/p\/[^/]+\/(c\/[^/]+\/)?(m|draft)\//.test(pathname);
  // Senza nessun account l'app non può fare nulla: si parte dalla procedura di benvenuto.
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const welcome = pathname.startsWith('/welcome');
  if (accounts && accounts.length === 0 && !welcome && !pathname.startsWith('/settings')) return <Navigate to="/welcome" replace />;
  return (
    <div className="pm-app">
      {!mailMode && !welcome && <TopBar onNewProject={() => navigate(paths.newProject())} onEditProject={editProject} />}
      <main className="pm-content" style={{ position: 'relative' }}>
        {editing.mode === 'projects' && <EditingDimmer />}
        <Routes>
          <Route path="/" element={<Navigate to={paths.project(SYSTEM_INBOX)} replace />} />
          <Route path="/p/:projectId" element={<ProjectRoute onEditProject={editProject} />} />
          <Route path="/p/:projectId/c/:conversationId" element={<ProjectRoute onEditProject={editProject} />} />
          <Route path="/p/:projectId/c/:conversationId/m/:messageId" element={<ProjectRoute onEditProject={editProject} />} />
          <Route path="/p/:projectId/c/:conversationId/draft/:draftId" element={<ProjectRoute onEditProject={editProject} />} />
          <Route path="/p/:projectId/draft/:draftId" element={<ProjectRoute onEditProject={editProject} />} />
          <Route path="/p/:projectId/settings" element={<ProjectSettingsRoute />} />
          <Route path="/projects/new" element={<ProjectSettingsPage projectId={null} />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/contacts" element={<ContactsRoute />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to={paths.project(SYSTEM_INBOX)} replace />} />
        </Routes>
      </main>
      <StatusBar />
      <SenderRuleHost />
      <RelatedMoveHost />
    </div>
  );
}

/** S1 · Progetto (con conversazione in focus e, per ora, messaggio in un pannello). */
function ProjectRoute({ onEditProject }: { onEditProject: (p: ProjectDto) => void }) {
  const { projectId = SYSTEM_INBOX, conversationId, messageId, draftId } = useParams();
  return (
    <ProjectPage
      key={projectId}
      projectKey={projectId}
      conversationId={conversationId ?? null}
      messageId={messageId ?? null}
      draftId={draftId ?? null}
      onEditProject={onEditProject}
    />
  );
}

function ProjectSettingsRoute() {
  const { projectId } = useParams();
  return <ProjectSettingsPage key={projectId} projectId={projectId ?? null} />;
}

function ContactsRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return <ContactsPage focusKey={params.get('focus')} onOpenConversation={(c) => navigate(paths.conversation(projectKeyOf(c), c.id))} />;
}
