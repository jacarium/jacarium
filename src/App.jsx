import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
// JQLBuilder stays eagerly imported: it is the always-rendered main shell and
// its mount effect kicks off startCloudSync() (cloud sync + WebSocket), which
// must keep running at app start. The standalone-window pages below are
// lazy-loaded so each window only parses the code for the page it shows.
import JQLBuilder from './components/JQLBuilder';
import { NotificationProvider } from './contexts/NotificationContext';
import { ChatProvider } from './contexts/ChatContext';
import { ThemeProvider } from './contexts/ThemeContext';
import ToastNotifications from './components/common/ToastNotifications';
// Mounted in every branch below (like ToastNotifications) so the bottom-right
// status corner (debug status bar + connection indicator) can appear in every
// window - main shell and each standalone window. Each part renders null
// while its setting is off.
import StatusCorner from './components/common/StatusCorner';
import CloudSyncNotification from './components/common/CloudSyncNotification';
import WhatsNew from './components/WhatsNew';
import UpdateAvailable from './components/UpdateAvailable';

const ToolsPage = lazy(() => import('./components/ToolsPage'));
const DiagnosticsPage = lazy(() => import('./components/DiagnosticsPage'));
const AIChatPage = lazy(() => import('./components/AIChatPage'));
const CalendarsPage = lazy(() => import('./components/CalendarsPage'));
const KanbanPage = lazy(() => import('./components/KanbanPage'));
const WorkflowBuilder = lazy(() => import('./components/WorkflowBuilder'));
const TasksPage = lazy(() => import('./components/TasksPage'));

// Minimal full-window fallback for standalone windows while their page chunk
// loads; mirrors the app's existing Loader2 + animate-spin loading convention.
function StandaloneLoadingFallback() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <Loader2 className="animate-spin text-os-text-secondary" size={24} />
    </div>
  );
}

function App() {
  // Check if this is a standalone window
  const urlParams = new URLSearchParams(window.location.search);
  const standalone = urlParams.get('standalone');

  // Standalone Tools window - no sidebar, no other features
  if (standalone === 'tools') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <div className="h-screen w-screen overflow-hidden bg-os-background">
            <Suspense fallback={<StandaloneLoadingFallback />}>
              <ToolsPage />
            </Suspense>
          </div>
          <ToastNotifications />
          <StatusCorner />
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Standalone Diagnostics window - no sidebar, no other features
  if (standalone === 'diagnostics') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <div className="h-screen w-screen overflow-hidden bg-os-background">
            <Suspense fallback={<StandaloneLoadingFallback />}>
              <DiagnosticsPage />
            </Suspense>
          </div>
          <ToastNotifications />
          <StatusCorner />
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Standalone JQL Search window - no sidebar, minimal features
  if (standalone === 'search') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <ChatProvider>
            <JQLBuilder standalone="search" />
            <ToastNotifications />
            <StatusCorner />
          </ChatProvider>
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Standalone AI Chat (Robin) window - no sidebar, no other features
  if (standalone === 'ai-chat') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <div className="h-screen w-screen overflow-hidden bg-os-background">
            <Suspense fallback={<StandaloneLoadingFallback />}>
              <AIChatPage />
            </Suspense>
          </div>
          <ToastNotifications />
          <StatusCorner />
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Standalone Calendar window - no sidebar, no other features
  if (standalone === 'calendars') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <div className="h-screen w-screen overflow-hidden bg-os-background">
            <Suspense fallback={<StandaloneLoadingFallback />}>
              <CalendarsPage />
            </Suspense>
          </div>
          <ToastNotifications />
          <StatusCorner />
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Standalone Kanban window - no sidebar, no other features
  if (standalone === 'kanban') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <div className="h-screen w-screen overflow-hidden bg-os-background">
            <Suspense fallback={<StandaloneLoadingFallback />}>
              <KanbanPage />
            </Suspense>
          </div>
          <ToastNotifications />
          <StatusCorner />
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Standalone Workflow Builder window - no sidebar, no other features
  if (standalone === 'workflow') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <div className="h-screen w-screen overflow-hidden bg-os-background">
            <Suspense fallback={<StandaloneLoadingFallback />}>
              <WorkflowBuilder />
            </Suspense>
          </div>
          <ToastNotifications />
          <StatusCorner />
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Standalone Tasks window - no sidebar, no other features
  if (standalone === 'tasks') {
    return (
      <ThemeProvider>
        <NotificationProvider>
          <div className="h-screen w-screen overflow-hidden bg-os-background">
            <Suspense fallback={<StandaloneLoadingFallback />}>
              <TasksPage />
            </Suspense>
          </div>
          <ToastNotifications />
          <StatusCorner />
        </NotificationProvider>
      </ThemeProvider>
    );
  }

  // Normal app with full features
  return (
    <ThemeProvider>
      <NotificationProvider>
        <ChatProvider>
          <JQLBuilder />
          <ToastNotifications />
          <StatusCorner />
          <CloudSyncNotification />
          <WhatsNew />
          <UpdateAvailable />
        </ChatProvider>
      </NotificationProvider>
    </ThemeProvider>
  );
}

export default App;
