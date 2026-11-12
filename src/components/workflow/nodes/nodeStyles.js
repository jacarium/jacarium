/**
 * Shared class-name helpers for workflow nodes. Kept separate from
 * NodeComponents.jsx so that file only exports components (Vite Fast Refresh).
 */

/**
 * Outer wrapper classes shared by every node. Centralises the status/selection
 * look so the whole graph can be restyled from one place.
 */
export function nodeShellClass({ status, isShared = false, className = '' }) {
  let state;
  if (status === 'processing') {
    state = 'border-os-blue workflow-node-processing';
  } else if (status === 'complete') {
    state = 'border-(--os-status-success)';
  } else if (status === 'error') {
    state = 'border-(--os-terminal-error)';
  } else if (isShared) {
    state = 'border-(--brand-accent)';
  } else {
    state = 'border-os-input-border';
  }
  return `workflow-node bg-os-card rounded-lg shadow-lg border-2 ${state} ${className}`.trim();
}
