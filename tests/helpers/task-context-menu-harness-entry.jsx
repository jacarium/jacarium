/**
 * Entry for tests/helpers/task-context-menu-harness.html (see there).
 * Exposes window.__harness so tests/tasks-create-document-in-theme.test.mjs
 * can drive the Tasks page's task context menu and toggle the theme:
 *
 *   __harness.rows()                 - number of task rows mounted
 *   __harness.openMenu(i, x?, y?)    - right-click row i (optionally at a
 *                                      viewport position, e.g. near an edge)
 *   __harness.hoverEntry()           - hover "Create Document In"
 *   __harness.setCategories([...])   - categories the submenu lists
 *   __harness.picked                 - [{ taskId, category }] selections made
 *   __harness.setDark(bool)          - same class ThemeContext toggles
 *
 * Everything is synthetic; the menu's onCreateDocumentIn only records the
 * pick (no document is created, no navigation).
 */
/* eslint-disable react-refresh/only-export-components -- test entry, renders as a side effect */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import TaskItem from '../../src/components/tasks/TaskItem.jsx';
import TaskContextMenu from '../../src/components/tasks/TaskContextMenu.jsx';
import { useContextMenu } from '../../src/hooks/useContextMenu.js';

const now = new Date().toISOString();
const TASKS = [
  { id: 1, uuid: 'task-1', description: 'Rotate the lab certificates', status: 'pending', project: 'lab', tags: ['ops'], priority: 'H', entry: now, modified: now, due: null, wait: null, start: null, end: null, annotations: [], depends: [], recur: null },
  { id: 2, uuid: 'task-2', description: 'Replace the pager battery', status: 'pending', project: '', tags: [], priority: '', entry: now, modified: now, due: null, wait: null, start: null, end: null, annotations: [], depends: [], recur: null },
];
const DEFAULT_CATEGORIES = ['Runbooks', 'Ops', 'Archive', 'General'];

function Harness() {
  const { contextMenu, contextMenuRef, openContextMenu, closeContextMenu } = useContextMenu();
  const [categories, setCategories] = React.useState(DEFAULT_CATEGORIES);
  const pickedRef = React.useRef([]);

  React.useEffect(() => {
    window.__harness = {
      rows: () => document.querySelectorAll('[data-testid="task-item"]').length,
      openMenu: (i, x, y) => {
        const row = document.querySelectorAll('[data-testid="task-item"]')[i];
        if (!row) return false;
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: x ?? Math.round(r.left + 40), clientY: y ?? Math.round(r.top + 12),
        }));
        return true;
      },
      hoverEntry: () => {
        const entry = document.querySelector('[data-testid="task-create-document-in"]');
        if (!entry) return false;
        entry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
        return true;
      },
      setCategories: (list) => setCategories(list),
      get picked() { return pickedRef.current; },
      setDark: (dark) => document.documentElement.classList.toggle('dark', !!dark),
    };
    window.__harnessReady = true;
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--os-canvas)', padding: 24 }}>
      <p style={{ color: 'var(--os-text-secondary)', fontFamily: 'sans-serif', fontSize: 13 }}>
        Task context menu theme harness - tests only
      </p>
      <div className="space-y-1.5" style={{ maxWidth: 640 }}>
        {TASKS.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            onToggleComplete={() => {}}
            onDelete={() => {}}
            onUpdate={() => {}}
            onStart={() => {}}
            onStop={() => {}}
            onAnnotate={() => {}}
            onDenotate={() => {}}
            projects={['lab']}
            isSelected={false}
            onToggleSelection={() => {}}
            onContextMenu={(e, t) => openContextMenu(e, 'task', t)}
          />
        ))}
      </div>
      <TaskContextMenu
        contextMenu={contextMenu}
        menuRef={contextMenuRef}
        categories={categories}
        // Same as TasksPage.handleCreateDocumentFromTask: close, then act
        onCreateDocumentIn={(task, category) => { closeContextMenu(); pickedRef.current.push({ taskId: task.id, category }); }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
