import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { ToastProvider } from './ui/toast.tsx';
import { ConfirmProvider } from './ui/confirm.tsx';
import { ContextMenuProvider } from './ui/contextMenu.tsx';
import { EditingProvider } from './ui/editing.tsx';
import 'material-symbols/outlined.css';
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
import './index.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components/app.css';
import './styles/components/topbar.css';
import './styles/components/statusbar.css';
import './styles/components/buttons.css';
import './styles/components/people.css';
import './styles/components/project.css';
import './styles/components/manage.css';
import './styles/components/mail.css';
import './styles/components/search.css';
import './styles/components/contacts.css';
import { BrowserRouter } from 'react-router-dom';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <ContextMenuProvider>
            <EditingProvider>
              <App />
            </EditingProvider>
          </ContextMenuProvider>
        </ConfirmProvider>
      </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
