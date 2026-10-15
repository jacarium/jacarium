import { useState } from 'react';

/**
 * Hooks shared by the workflow node components. Kept separate from
 * NodeComponents.jsx so that file only exports components (Vite Fast Refresh).
 */

/**
 * Keep a local copy of a persisted node value in step with changes made
 * from outside the component - undo/redo putting an older snapshot back.
 * `external` is the value in `data`; `onExternalChange` is called with it
 * when it changes and differs from what the component shows (`shown`).
 * Changes the component wrote itself come back equal to `shown` and are
 * ignored, so typing is never interrupted.
 *
 * This is React's "adjust state when a prop changes" pattern (a state
 * update during render, immediately re-rendered), not an effect, so the
 * field never paints a stale value.
 */
export function useFollowExternalValue(external, shown, onExternalChange) {
  const [known, setKnown] = useState(external);
  if (external !== known) {
    setKnown(external);
    if (external !== shown) {
      onExternalChange(external);
    }
  }
}

/**
 * A node field the user edits in place: a local copy of `data[key]` (so the
 * input stays responsive) plus a setter that pushes the new value through
 * `data.onChange` into the node's persisted data. Read-only nodes (a
 * workflow shared by a teammate without write access) ignore edits.
 *
 * `fallback` applies when the saved value is missing or falsy, matching how
 * the nodes have always initialised (`data.value || ''`). After an undo or
 * redo the local copy follows the restored value (useFollowExternalValue).
 */
export function useNodeField(data, key, fallback) {
  const [value, setValue] = useState(data[key] || fallback);
  const isReadOnly = data.isReadOnly || false;

  useFollowExternalValue(data[key], value, (external) => setValue(external ?? fallback));

  const update = (next) => {
    if (isReadOnly) return;
    setValue(next);
    if (data.onChange) {
      data.onChange({ [key]: next });
    }
  };

  return [value, update];
}

/** "Copy" button state: writes `text` to the clipboard and shows a tick for 2s. */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);

  const copy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return { copied, copy };
}
