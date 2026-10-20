import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useShortcutBindings } from '../../shortcuts/useShortcut';
import { useKeyboardLayout } from '../../shortcuts/layout';
import { actionById, aliasesOf, formatChord, platformOf } from '../../shortcuts/registry';
import { detectOs, isMacOs } from '../../shortcuts/store';

/**
 * The editor's shortcuts and gestures, grouped as the popover shows them.
 * The chords of the registry's actions (fit, quick-add, undo/redo, copy/
 * paste) are the ones bound on this device - Settings > Shortcuts can move
 * them - with their fixed aliases; the mouse gestures are fixed.
 */
function sections(bindings, { mac, layout }) {
  const platform = platformOf(detectOs());
  const chords = (id) => {
    const bound = bindings[id];
    const all = [bound, ...aliasesOf(actionById(id), platform)].filter(Boolean).map((c) => formatChord(c, { mac, layout }));
    return all.length ? all.join('  or  ') : 'Not bound';
  };
  const MOD = mac ? '⌘' : 'Ctrl';
  return [
    {
      title: 'Moving around',
      items: [
        ['Scroll / two-finger swipe', 'Pan the canvas'],
        [`${MOD} + scroll, pinch`, 'Zoom'],
        ['Space + drag, middle or right drag', 'Pan'],
        ['Drag on empty canvas', 'Select nodes in a box'],
        [chords('workflow.fit'), 'Fit the workflow into view'],
      ],
    },
    {
      title: 'Adding and wiring',
      items: [
        [`${chords('workflow.quickAdd')}, double-click or right-click on empty canvas`, 'Quick-add a node at the pointer'],
        ['Drag a wire onto empty canvas', 'Add a connected node'],
        ['Click a wire, then Delete', 'Remove the wire'],
        [`${MOD} + click a wire`, 'Remove the wire'],
        ['Drag a node from the library', 'Add it where it is dropped'],
      ],
    },
    {
      title: 'Editing',
      items: [
        [chords('workflow.undo'), 'Undo'],
        [chords('workflow.redo'), 'Redo'],
        [`${chords('workflow.copyNodes')},  ${chords('workflow.pasteNodes')}`, 'Copy and paste the selected nodes'],
        ['Delete / Backspace', 'Delete the selection'],
        ['Arrow keys', 'Nudge the selected node'],
        ['Shift + drag, Ctrl + click', 'Add to the selection'],
        ['Right-click a node', 'Layer order and pin clearing'],
      ],
    },
  ];
}

/**
 * The "?" popover of the toolbar: a card listing the editor's keyboard
 * shortcuts and mouse gestures. Closes on Escape, on an outside click or
 * with its own close button. Theme tokens throughout, so it reads the same
 * in light and dark.
 */
export default function ShortcutsHelp({ anchorRef, onClose }) {
  const panelRef = useRef(null);
  const bindings = useShortcutBindings();
  const layout = useKeyboardLayout();
  const SECTIONS = sections(bindings, { mac: isMacOs(), layout });

  useEffect(() => {
    function handleMouseDown(event) {
      if (panelRef.current && !panelRef.current.contains(event.target) && !anchorRef?.current?.contains(event.target)) {
        onClose();
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, anchorRef]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Keyboard shortcuts"
      data-testid="workflow-shortcuts-help"
      className="absolute right-4 top-full mt-1 z-50 w-[380px] max-h-[70vh] overflow-y-auto bg-os-card border border-os-border rounded-lg shadow-xl text-os-text-primary"
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-os-border">
        <span className="text-sm font-semibold">Keyboard shortcuts</span>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="p-1 rounded-sm text-os-text-secondary hover:bg-os-card-secondary hover:text-os-text-primary transition-colors"
        >
          <X size={14} />
        </button>
      </div>
      <div className="px-4 py-3 space-y-4">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <div className="text-xs font-semibold text-os-text-secondary uppercase tracking-wide mb-1.5">{section.title}</div>
            <dl className="space-y-1">
              {section.items.map(([keys, what]) => (
                <div key={keys} className="flex items-start gap-3 text-xs">
                  <dt className="shrink-0 w-[172px] font-mono text-os-text-primary bg-os-card-secondary border border-os-border rounded-sm px-1.5 py-0.5 leading-snug">{keys}</dt>
                  <dd className="text-os-text-secondary pt-0.5">{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
