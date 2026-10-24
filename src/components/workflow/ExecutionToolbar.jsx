import { useState, useRef } from 'react';
import { useShortcutHint } from '../../shortcuts/useShortcut';
import { Play, Square, Eraser, Undo2, Redo2, Magnet, AlignCenterHorizontal, ChevronDown, LayoutGrid, CircleHelp } from 'lucide-react';
import AlignMenu from './AlignMenu';
import ShortcutsHelp from './ShortcutsHelp';

function ToolbarButton({ onClick, disabled, title, active = false, buttonRef, children }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      className={`p-1.5 transition-colors rounded-sm ${
 disabled
 ?'text-os-text-muted cursor-not-allowed'
 : active
 ?'btn-selected'
 :'text-os-text-secondary hover:bg-os-card-secondary hover:text-os-text-primary'
 }`}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="w-px h-5 bg-os-border mx-1" aria-hidden="true" />;

/**
 * The bar above the canvas: Undo / Redo, Run / Stop / Clear, then the
 * layout tools (snap to grid, align/distribute the selection, auto-tidy)
 * and the shortcuts help.
 *
 * - Undo / Redo step through the canvas history (disabled at either end,
 *   and for read-only viewers, who cannot edit).
 * - Run starts execution (disabled while running); Stop halts it.
 * - Clear resets output shown in Visualizer/Result/Comparison nodes between
 *   runs; disabled while a run is in progress so it cannot race the engine.
 * - Snap to grid is a toggle remembered per viewer; Align needs a selection
 *   of two or more nodes; Tidy lays the whole workflow out along its flow.
 */
export default function ExecutionToolbar({
  isExecuting, onRun, onStop, onClear,
  canUndo = false, canRedo = false, onUndo, onRedo,
  canEdit = true,
  snapToGrid = false, onToggleSnap,
  selectedCount = 0, onAlign, onDistribute, onTidy
}) {
  const [alignOpen, setAlignOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const alignButtonRef = useRef(null);
  const helpButtonRef = useRef(null);
  // the tooltips name the chords bound on this device (src/shortcuts)
  const undoHint = useShortcutHint('workflow.undo');
  const redoHint = useShortcutHint('workflow.redo');

  return (
    <div className="border-b border-os-border px-4 py-2 flex items-center gap-1 shrink-0 bg-os-card relative">
      <ToolbarButton onClick={onUndo} disabled={!canUndo} title={`Undo${undoHint}`}>
        <Undo2 size={18} />
      </ToolbarButton>
      <ToolbarButton onClick={onRedo} disabled={!canRedo} title={`Redo${redoHint}`}>
        <Redo2 size={18} />
      </ToolbarButton>
      <Divider />
      <ToolbarButton onClick={onRun} disabled={isExecuting} title="Run workflow">
        <Play size={18} />
      </ToolbarButton>
      <ToolbarButton onClick={onStop} disabled={!isExecuting} title="Stop execution">
        <Square size={18} />
      </ToolbarButton>
      <Divider />
      <ToolbarButton onClick={onClear} disabled={isExecuting} title="Clear node outputs">
        <Eraser size={18} />
      </ToolbarButton>
      <Divider />
      <ToolbarButton onClick={onToggleSnap} disabled={!canEdit} active={snapToGrid} title={snapToGrid ? 'Snap to grid: on' : 'Snap to grid: off'}>
        <Magnet size={18} />
      </ToolbarButton>
      <div className="relative">
        <ToolbarButton buttonRef={alignButtonRef} onClick={() => setAlignOpen((open) => !open)} disabled={!canEdit || selectedCount < 2} title="Align or distribute the selected nodes">
          <span className="flex items-center">
            <AlignCenterHorizontal size={18} />
            <ChevronDown size={12} className="ml-0.5" />
          </span>
        </ToolbarButton>
        {alignOpen && (
          <AlignMenu
            anchorRef={alignButtonRef}
            selectedCount={selectedCount}
            onAlign={onAlign}
            onDistribute={onDistribute}
            onClose={() => setAlignOpen(false)}
          />
        )}
      </div>
      <ToolbarButton onClick={onTidy} disabled={!canEdit} title="Tidy up: lay the workflow out along its flow">
        <LayoutGrid size={18} />
      </ToolbarButton>

      {isExecuting && (
        <div className="flex items-center gap-2 ml-3">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
          <span className="text-xs text-os-text-secondary">Executing workflow...</span>
        </div>
      )}

      <div className="ml-auto">
        <ToolbarButton buttonRef={helpButtonRef} onClick={() => setHelpOpen((open) => !open)} active={helpOpen} title="Keyboard shortcuts">
          <CircleHelp size={18} />
        </ToolbarButton>
      </div>
      {helpOpen && <ShortcutsHelp anchorRef={helpButtonRef} onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
