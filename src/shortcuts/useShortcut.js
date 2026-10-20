/**
 * Keyboard shortcuts in the renderer: components subscribe to an ACTION
 * (src/shortcuts/registry.js) instead of testing keys themselves, and one
 * window keydown listener (capture phase, installed on first use) resolves
 * the pressed chord to the actions bound to it on this device
 * (src/shortcuts/store.js) and runs the innermost registered handler:
 *
 *   useShortcut('editor.find', () => openFind());                 // the editor
 *   useShortcut('workflow.copyNodes', copy, { when: (e) => !isEditableTarget(e.target) });
 *
 * Scope decides who gets a chord that several actions share: 'editor'
 * handlers run only when the document editor's textarea has focus,
 * 'workflow-canvas' and 'page:*' handlers only while their component is
 * mounted (and their `when` agrees), 'global' handlers always; the
 * innermost wins and the event is consumed (preventDefault +
 * stopPropagation, so the browser's own Ctrl+F or a React handler
 * underneath never fires too). A handler that returns false declines
 * (copy with a text selection, Tab outside a list) and the event goes on
 * as if unbound.
 *
 * Actions the desktop menu owns (owner 'menu': Settings, Toggle sidebar,
 * zoom, the Pages) are never dispatched here while the Electron bridge
 * exists - the menu accelerator fires them, so nothing fires twice; in a
 * browser the same registrations handle them.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { actionById, actionsForChord, chordFromEvent, platformOf, scopePriority } from './registry.js';
import { buildKind, detectOs, getBindings, isMacOs, isRecording, labelFor, subscribe } from './store.js';
import { useKeyboardLayout } from './layout.js';

const registrations = new Map();   // actionId -> Set<{ handlerRef, whenRef, scope }>
let installed = false;

function scopeActive(scope, e) {
  if (scope === 'editor') {
    const t = e.target;
    return !!(t && typeof t.closest === 'function' && t.closest('.sc-editor-textarea'));
  }
  return true;
}

function dispatch(e) {
  if (e.defaultPrevented || e.isComposing || isRecording()) return;
  const os = detectOs();
  const platform = platformOf(os);
  const chord = chordFromEvent(e, platform);
  if (!chord) return;
  const desktop = buildKind() === 'desktop';
  const candidates = [];
  for (const action of actionsForChord(chord, getBindings(), platform)) {
    if (desktop && action.owner === 'menu') continue;
    for (const reg of registrations.get(action.id) || []) candidates.push({ ...reg, action });
  }
  candidates.sort((a, b) => scopePriority(a.action.scope) - scopePriority(b.action.scope));
  for (const reg of candidates) {
    if (!scopeActive(reg.action.scope, e)) continue;
    if (reg.whenRef.current && !reg.whenRef.current(e)) continue;
    const result = reg.handlerRef.current ? reg.handlerRef.current(e) : false;
    if (result === false) continue;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', dispatch, true);
}

/**
 * Run `handler` when the action's chord is pressed in its scope. `when`
 * can veto per event; `enabled` false unregisters.
 */
export function useShortcut(actionId, handler, { when = null, enabled = true } = {}) {
  const handlerRef = useRef(handler);
  const whenRef = useRef(when);
  useEffect(() => { handlerRef.current = handler; whenRef.current = when; });
  useEffect(() => {
    if (!enabled) return undefined;
    const action = actionById(actionId);
    if (!action) { console.warn(`[shortcuts] unknown action ${actionId}`); return undefined; }
    install();
    const reg = { handlerRef, whenRef, scope: action.scope };
    if (!registrations.has(actionId)) registrations.set(actionId, new Set());
    registrations.get(actionId).add(reg);
    return () => { registrations.get(actionId)?.delete(reg); };
  }, [actionId, enabled]);
}

/** The bindings in force ({ actionId: chord | null }); re-renders on change. */
export function useShortcutBindings() {
  return useSyncExternalStore(subscribe, getBindings, getBindings);
}

/** The current label of an action's chord for tooltips ("⌘I", "Ctrl+I"), '' when unassigned. */
export function useShortcutLabel(actionId) {
  useSyncExternalStore(subscribe, getBindings, getBindings);
  const layout = useKeyboardLayout();
  return labelFor(actionId, layout);
}

/** " (⌘I)" to append to a tooltip, or '' when the action has no chord. */
export function useShortcutHint(actionId) {
  const label = useShortcutLabel(actionId);
  return label ? ` (${label})` : '';
}

export { isMacOs };
