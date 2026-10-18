import { memo } from 'react';
import { Lightbulb } from 'lucide-react';
import { LinkHandles } from './NodeComponents';
import { NOTE_COLOR_KEYS, DEFAULT_NOTE_COLOR, getNoteColor } from './noteColors';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

/**
 * Compact "bubble" node for mind-map topics. Single-line label, coloured pill,
 * link handles on all four sides. No execution semantics (see NoteNode).
 */
function IdeaNode({ data, isConnectable, selected }) {
  const [label, setLabel] = useNodeField(data, 'label', nodeFieldDefault('idea', 'label'));
  const colorKey = data.color || DEFAULT_NOTE_COLOR;
  const color = getNoteColor(colorKey);
  const isReadOnly = data.isReadOnly || false;

  // Clicking the bulb cycles through the palette
  const handleCycleColor = () => {
    if (isReadOnly) return;
    const next = NOTE_COLOR_KEYS[(NOTE_COLOR_KEYS.indexOf(colorKey) + 1) % NOTE_COLOR_KEYS.length];
    data.onChange?.({ color: next });
  };

  return (
    <div
      className="workflow-node workflow-idea min-w-[150px] flex items-center gap-2 rounded-full border-2 shadow-lg pl-2 pr-3 py-1.5 cursor-grab active:cursor-grabbing"
      style={{ backgroundColor: color.tint, borderColor: selected ? color.solid : color.border }}
    >
      <LinkHandles color={color.solid} isConnectable={isConnectable} />

      <button
        type="button"
        onClick={handleCycleColor}
        title="Change colour"
        className="nodrag p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
        style={{ color: color.solid }}
      >
        <Lightbulb size={14} />
      </button>
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        disabled={isReadOnly}
        placeholder="Idea..."
        className="nodrag field-inline flex-1 min-w-0 bg-transparent text-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden disabled:cursor-not-allowed"
      />
    </div>
  );
}

export default memo(IdeaNode);
