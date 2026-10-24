import { useState, useRef, useEffect } from 'react';
import { ListTodo, X } from 'lucide-react';
import { getAllInstances } from '../../../utils/taskwarriorInstances';
import { createTask, syncToTaskWarrior } from '../../../utils/tasks';
import { useNotifications } from '../../../contexts/NotificationContext';
import DatePicker from '../../common/inputs/DatePicker';
import {
  QUICK_TASK_PRIORITIES,
  QUICK_TASK_DEFAULT_PRIORITY,
  QUICK_TASK_LAST_INSTANCE_KEY,
  pickDefaultInstanceId,
  validateQuickTask,
  buildQuickTask,
} from '../../../utils/quickTasks';

/**
 * QuickTasks - Create a TaskWarrior task from the document editor (/task)
 *
 * Same floating window as QuickWorkflow (/wf) and Quick AI (/ai): anchored
 * near the caret, draggable by its header, backdrop click / Esc / X close it.
 *
 * Features:
 * - Instance dropdown (TaskWarrior instances from the Tasks page), preselects
 *   the last-used one
 * - Task text, optional due date (the Tasks page's own DatePicker, stored
 *   the same way) and priority; the task is created "now" like one added
 *   on the Tasks page
 * - Inline validation (text required)
 * - Creates the task through the Tasks page's own createTask() so it shows
 *   up there exactly like a task added on that page, then pushes the instance
 *   to the TaskWarrior CLI in the background like the Tasks page does
 */
export default function QuickTasks({
  visible,
  position,
  onClose,
  onCreated,
}) {
  const { addNotification } = useNotifications();
  const [instances, setInstances] = useState([]);
  const [instancesLoaded, setInstancesLoaded] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState(''); // "YYYY-MM-DD" from the DatePicker, '' = none
  const [priority, setPriority] = useState(QUICK_TASK_DEFAULT_PRIORITY);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const [popupPos, setPopupPos] = useState(position);
  const descriptionRef = useRef(null);
  const dueFieldRef = useRef(null);

  useEffect(() => {
    if (!visible) return undefined;
    // Intentional init-on-open: reload the instances and reset the previous
    // form (async loader sets state post-await), same as QuickWorkflow.
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDescription('');
    setDue('');
    setPriority(QUICK_TASK_DEFAULT_PRIORITY);
    setErrors({});
    setSubmitError(null);
    setSubmitting(false);
    setInstancesLoaded(false);
    (async () => {
      let list = [];
      try {
        list = await getAllInstances();
      } catch (err) {
        console.error('[QuickTasks] Failed to load instances:', err);
      }
      if (cancelled) return;
      setInstances(list);
      const preferred = pickDefaultInstanceId(list);
      setInstanceId(preferred === null ? '' : String(preferred));
      setInstancesLoaded(true);
    })();
    const focusTimer = setTimeout(() => descriptionRef.current?.focus(), 100);
    return () => {
      cancelled = true;
      clearTimeout(focusTimer);
    };
  }, [visible]);

  useEffect(() => {
    // Intentional prop-to-state sync: the popup tracks the caller-provided
    // anchor until the user drags it elsewhere.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPopupPos(position);
  }, [position]);

  function handleMouseDown(e) {
    if (e.target.closest('.drag-handle')) {
      setIsDragging(true);
      dragStartRef.current = {
        left: popupPos.x,
        top: popupPos.y,
        x: e.clientX,
        y: e.clientY
      };
    }
  }

  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      const newLeft = dragStartRef.current.left + deltaX;
      const newTop = dragStartRef.current.top + deltaY;

      setPopupPos({ x: Math.max(0, newLeft), y: Math.max(0, newTop) });
    }

    function handleMouseUp() {
      setIsDragging(false);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  function handleClose() {
    if (submitting) return;
    onClose();
  }

  // Is the due-date DatePicker's calendar open? It renders its dropdown
  // inside the field wrapper (position: fixed), and closes itself on Esc
  // through its own document-level listener.
  function isDuePickerOpen() {
    return !!dueFieldRef.current?.querySelector('.fixed');
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      // Esc while the calendar is open only closes the calendar (the
      // DatePicker handles that); the window stays open for a second Esc.
      if (isDuePickerOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  }

  // The <select> holds ids as strings; instance ids are numbers (Dexie ++id)
  const selectedInstance = instances.find((i) => String(i.id) === instanceId) || null;
  const noInstances = instancesLoaded && instances.length === 0;

  async function handleSubmit() {
    if (submitting) return;
    const form = { description, due, priority, instanceId: selectedInstance ? selectedInstance.id : null };
    const nextErrors = validateQuickTask(form);
    setErrors(nextErrors);
    setSubmitError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    const instance = selectedInstance;
    try {
      const task = buildQuickTask(form);
      const id = await createTask(task);
      try {
        localStorage.setItem(QUICK_TASK_LAST_INSTANCE_KEY, JSON.stringify(instance.id));
      } catch {
        // storage unavailable - remembering the instance is a convenience only
      }
      addNotification({
        type: 'success',
        title: 'Task created',
        message: `"${task.description}" added to ${instance.name}`,
      });
      // Push the instance to the TaskWarrior CLI like the Tasks page does
      // after every change. Best effort: syncToTaskWarrior never throws, it
      // reports { success: false } when the backend is unavailable and the
      // task simply stays local until the Tasks page syncs it.
      syncToTaskWarrior(instance.id, instance.rcPath || null, instance.dataPath || null)
        .then((result) => {
          if (!result?.success) console.warn('[QuickTasks] TaskWarrior sync skipped:', result?.error);
        })
        .catch((err) => console.warn('[QuickTasks] TaskWarrior sync failed:', err));
      setSubmitting(false);
      onCreated?.({ ...task, id }, instance);
    } catch (err) {
      console.error('[QuickTasks] Failed to create task:', err);
      setSubmitting(false);
      setSubmitError(err?.message || 'Failed to create task');
      addNotification({ type: 'error', title: 'Task not created', message: err?.message || 'Failed to create task' });
    }
  }

  if (!visible) return null;

  const inputClass = 'w-full px-2 py-1.5 text-sm border rounded-sm bg-os-input-bg text-os-text-primary focus:outline-hidden focus:border-purple-500 focus:ring-1 focus:ring-purple-500 disabled:opacity-60 disabled:cursor-not-allowed';
  const borderFor = (field) => (errors[field] ? 'border-red-500' : 'border-os-input-border');
  const labelClass = 'block text-xs font-medium text-os-text-secondary mb-1';
  const errorClass = 'text-xs text-red-700 dark:text-red-300 mt-1';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={handleClose}
      />

      {/* Popup */}
      <div
        className="fixed z-50 bg-os-card rounded-lg shadow-2xl border border-os-border"
        style={{
          left: `${popupPos.x}px`,
          top: `${popupPos.y}px`,
          width: '480px',
          maxHeight: '600px',
          cursor: isDragging ? 'grabbing' : 'default'
        }}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Quick Tasks"
        data-testid="quick-tasks-popup"
      >
        {/* Header */}
        <div className="drag-handle flex items-center justify-between p-3 border-b border-os-border bg-linear-to-r from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 cursor-grab active:cursor-grabbing rounded-t-lg">
          <div className="flex items-center gap-2">
            <ListTodo size={16} className="text-purple-600 dark:text-purple-300" />
            <span className="text-sm font-semibold text-purple-900 dark:text-purple-200">Quick Tasks</span>
          </div>
          <button
            onClick={handleClose}
            className="btn btn-brand-ghost p-1"
            title="Close (Esc)"
          >
            <X size={16} className="text-purple-700 dark:text-purple-300" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto space-y-3" style={{ maxHeight: '480px' }}>
          {/* Instance */}
          <div>
            <label className={labelClass} htmlFor="quick-task-instance">Instance</label>
            <select
              id="quick-task-instance"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              disabled={!instancesLoaded || noInstances || submitting}
              className={`${inputClass} ${borderFor('instance')}`}
            >
              {!instancesLoaded && <option value="">Loading instances...</option>}
              {noInstances && <option value="">No instances available</option>}
              {instances.map((instance) => (
                <option key={instance.id} value={String(instance.id)}>
                  {instance.name}{instance.category ? ` (${instance.category})` : ''}
                </option>
              ))}
            </select>
            {noInstances && (
              <p className="text-xs text-os-text-secondary mt-1" data-testid="quick-tasks-no-instances">
                No TaskWarrior instances yet. Create one on the Tasks page first.
              </p>
            )}
            {errors.instance && <p className={errorClass} role="alert">{errors.instance}</p>}
          </div>

          {/* Task text */}
          <div>
            <label className={labelClass} htmlFor="quick-task-description">Task</label>
            <input
              ref={descriptionRef}
              id="quick-task-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="What needs to be done?"
              disabled={noInstances || submitting}
              className={`${inputClass} ${borderFor('description')}`}
              aria-invalid={!!errors.description}
            />
            {errors.description && <p className={errorClass} role="alert">{errors.description}</p>}
          </div>

          {/* Due date - the Tasks page's DatePicker, same value/onChange
              convention as TaskItem's due-date editor */}
          <div ref={dueFieldRef} data-testid="quick-task-due">
            <label className={labelClass} id="quick-task-due-label">Due date</label>
            <DatePicker
              value={due}
              onChange={(newDate) => setDue(newDate || '')}
              placeholder="No due date"
              disabled={noInstances || submitting}
              className={`${inputClass} ${borderFor('due')} text-left`}
            />
            {errors.due && <p className={errorClass} role="alert">{errors.due}</p>}
          </div>

          {/* Priority */}
          <div>
            <label className={labelClass} htmlFor="quick-task-priority">Priority</label>
            <select
              id="quick-task-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              disabled={noInstances || submitting}
              className={`${inputClass} border-os-input-border`}
            >
              {QUICK_TASK_PRIORITIES.map((p) => (
                <option key={p.value || 'none'} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          <p className="text-xs text-os-text-secondary">
            Due date is optional. Enter to create, Esc to cancel.
          </p>

          {submitError && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-700 dark:text-red-300" role="alert">
              <div className="font-medium mb-1">Error:</div>
              <div className="text-xs">{submitError}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-os-border flex justify-end gap-2 bg-os-card-secondary rounded-b-lg">
          <button
            onClick={handleClose}
            disabled={submitting}
            className="px-4 py-2 bg-os-card text-os-text-primary border border-os-border text-sm rounded-sm hover:bg-os-card-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!instancesLoaded || noInstances || submitting}
            className="btn btn-brand flex items-center justify-center gap-2 px-4 py-2 text-sm"
            title={noInstances ? 'Create a TaskWarrior instance on the Tasks page first' : 'Create task (Enter)'}
            data-testid="quick-tasks-submit"
          >
            {submitting ? (
              <>
                Creating...
              </>
            ) : (
              <>
                Create Task
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}
