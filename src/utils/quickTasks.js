/**
 * Quick Tasks helpers - the pure logic behind the Documents editor's /task
 * popup (src/components/features/documents/QuickTasks.jsx).
 *
 * "Task" here is a TaskWarrior task (src/utils/tasks.js, db.tasks) and
 * "instance" a TaskWarrior instance (src/utils/taskwarriorInstances.js,
 * db.taskwarriorInstances) - the same objects the Tasks page works with.
 * The popup captures text, an optional due date and priority; the task is
 * created "now" (entry/modified) with no scheduled/wait dates, exactly like
 * a task added on the Tasks page. The due date is stored the way the Tasks
 * page's DatePicker stores it (src/components/tasks/TaskItem.jsx):
 * "YYYY-MM-DD" -> "YYYY-MM-DDT00:00:00Z".
 */

// Same values the Tasks page uses (src/components/tasks/TaskItem.jsx);
// '' is TaskWarrior's default "no priority", which is also what
// TasksPage.handleAddTask creates.
export const QUICK_TASK_PRIORITIES = [
  { value: '', label: 'None' },
  { value: 'L', label: 'Low' },
  { value: 'M', label: 'Medium' },
  { value: 'H', label: 'High' },
];
export const QUICK_TASK_DEFAULT_PRIORITY = '';

// The popup remembers which instance it last created a task in (its own key,
// so it never changes which instance the Tasks page opens next time).
export const QUICK_TASK_LAST_INSTANCE_KEY = 'quickTasksLastInstanceId';
// The Tasks page persists its currently open instance under this key
// (useLocalStorage -> JSON encoded) - second choice for the default.
export const TASKS_PAGE_INSTANCE_KEY = 'currentTaskInstanceId';

function readStoredId(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined || raw === '') return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'number' || typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Which instance the popup should preselect: the one it last used, else the
 * one open on the Tasks page, else the active instance, else the first one.
 * @param {Array} instances - rows from getAllInstances() (active first)
 * @param {Storage} [storage] - defaults to window.localStorage
 * @returns {number|string|null} instance id, or null when there are none
 */
export function pickDefaultInstanceId(instances, storage = globalThis.localStorage) {
  if (!Array.isArray(instances) || instances.length === 0) return null;
  const ids = new Set(instances.map((i) => i.id));
  if (storage) {
    for (const key of [QUICK_TASK_LAST_INSTANCE_KEY, TASKS_PAGE_INSTANCE_KEY]) {
      const stored = readStoredId(storage, key);
      if (stored !== null && ids.has(stored)) return stored;
    }
  }
  const active = instances.find((i) => i.isActive === 1 || i.isActive === true);
  return (active || instances[0]).id;
}

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The DatePicker's "YYYY-MM-DD" value as the Tasks page stores a due date
 * (TaskItem.jsx: `${newDate}T00:00:00Z`), or null when empty.
 */
export function dueDateToStored(dateStr) {
  if (!dateStr || typeof dateStr !== 'string' || !DUE_DATE_RE.test(dateStr)) return null;
  return `${dateStr}T00:00:00Z`;
}

/**
 * Validate the form. Returns an object keyed by field with a message for
 * every problem (empty object = valid).
 */
export function validateQuickTask({ description, due, instanceId }) {
  const errors = {};
  if (instanceId === null || instanceId === undefined || instanceId === '') {
    errors.instance = 'Select an instance';
  }
  if (!description || !description.trim()) {
    errors.description = 'Task text is required';
  }
  if (due && !DUE_DATE_RE.test(due)) {
    errors.due = 'Invalid due date';
  }
  return errors;
}

/**
 * Build the row handed to createTask() (src/utils/tasks.js) - the same shape
 * TasksPage.handleAddTask creates, plus the priority and the optional due
 * date. createTask fills uuid/tags/project/other dates/etc. with its usual
 * defaults (null dates).
 * @param {{ description: string, due?: string, priority?: string, instanceId: number|string }} form
 * @param {Date} [now]
 */
export function buildQuickTask({ description, due, priority, instanceId }, now = new Date()) {
  const stamp = now.toISOString();
  const allowed = new Set(QUICK_TASK_PRIORITIES.map((p) => p.value));
  return {
    description: (description || '').trim(),
    instanceId,
    status: 'pending',
    priority: allowed.has(priority) ? priority : QUICK_TASK_DEFAULT_PRIORITY,
    due: dueDateToStored(due),
    entry: stamp,
    modified: stamp,
  };
}
