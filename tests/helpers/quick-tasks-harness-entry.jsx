/**
 * Entry for tests/helpers/quick-tasks-harness.html (see there). Exposes
 * window.__harness so tests/documents-quick-tasks-theme.test.mjs can show
 * the Quick Tasks popup and toggle the theme:
 *
 *   __harness.seed()       - one synthetic TaskWarrior instance in the
 *                            (throwaway profile's) IndexedDB
 *   __harness.clear()      - remove every instance (no-instances state)
 *   __harness.show()       - mount the popup fresh (remount on every call)
 *   __harness.hide()
 *   __harness.setDark(bool) - same class ThemeContext toggles
 *
 * All content is synthetic; the popup's best-effort TaskWarrior CLI push is
 * disabled by pointing fetch at a rejecting stub, so nothing reaches the
 * network.
 */
/* eslint-disable react-refresh/only-export-components -- test entry, renders as a side effect */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import QuickTasks from '../../src/components/features/documents/QuickTasks.jsx';
import { NotificationProvider } from '../../src/contexts/NotificationContext.jsx';
import { db } from '../../src/db/database.js';
import { createInstance } from '../../src/utils/taskwarriorInstances.js';
import { getTasks } from '../../src/utils/tasks.js';

window.fetch = () => Promise.reject(new Error('no backend in the theme harness'));

function Harness() {
  const [view, setView] = React.useState(null); // null | { key }

  React.useEffect(() => {
    let key = 0;
    window.__harness = {
      seed: async () => {
        await db.taskwarriorInstances.clear();
        await db.tasks.clear();
        await createInstance({ name: 'Alpha Lab', category: 'General', isActive: 1 });
      },
      clear: async () => { await db.taskwarriorInstances.clear(); },
      tasks: () => getTasks(),
      show: () => setView({ key: ++key }),
      hide: () => setView(null),
      setDark: (dark) => document.documentElement.classList.toggle('dark', !!dark),
    };
    window.__harnessReady = true;
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--os-canvas)', padding: 24 }}>
      <p style={{ color: 'var(--os-text-secondary)', fontFamily: 'sans-serif', fontSize: 13 }}>
        Quick Tasks theme harness - tests only
      </p>
      {view && (
        <QuickTasks
          key={view.key}
          visible={true}
          position={{ x: 40, y: 60 }}
          onClose={() => setView(null)}
          onCreated={() => setView(null)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <NotificationProvider>
    <Harness />
  </NotificationProvider>
);
