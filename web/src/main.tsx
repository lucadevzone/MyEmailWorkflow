import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { ToastProvider } from './ui/toast.tsx';
import { ConfirmProvider } from './ui/confirm.tsx';
import { ContextMenuProvider } from './ui/contextMenu.tsx';
import 'material-symbols/outlined.css';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <ContextMenuProvider>
            <App />
          </ContextMenuProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
