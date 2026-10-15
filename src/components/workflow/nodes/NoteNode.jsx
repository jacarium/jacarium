import { memo } from 'react';
import { NodeResizer } from 'reactflow';
import { StickyNote } from 'lucide-react';
import { LinkHandles } from './NodeComponents';
import { NOTE_COLORS, NOTE_COLOR_KEYS, DEFAULT_NOTE_COLOR, getNoteColor } from './noteColors';
import { useNodeField } from './nodeHooks';

/**
 * Freeform sticky note. Has no execution semantics: it is skipped by the
 * execution engine and only carries "link" (data-typed) edges so notes can be
 * wired together as a lightweight mind map on the same canvas.
 */
function NoteNode({ data, isConnectable, selected }) {
  const [text, setText] = useNodeField(data, 'text', '');
  const colorKey = data.color || DEFAULT_NOTE_COLOR;
  const color = getNoteColor(colorKey);
  const isReadOnly = data.isReadOnly || false;

  const handleColorChange = (key) => {
    if (isReadOnly) return;
    data.onChange?.({ color: key });
  };

  return (
    <div
      className="workflow-node workflow-note h-full w-full min-w-[180px] min-h-[110px] flex flex-col rounded-lg border-2 shadow-lg"
      style={{ backgroundColor: color.tint, borderColor: selected ? color.solid : color.border }}
    >
      <NodeResizer
        isVisible={selected && !isReadOnly}
        minWidth={180}
        minHeight={110}
        lineClassName="border-transparent!"
        handleClassName="w-2.5! h-2.5! rounded-xs! border-0!"
        handleStyle={{ backgroundColor: color.solid }}
      />

      <LinkHandles color={color.solid} isConnectable={isConnectable} />

      {/* Header / drag strip */}
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1 cursor-grab active:cursor-grabbing">
        <StickyNote size={14} style={{ color: color.solid }} />
        <span className="text-xs font-semibold text-os-text-secondary uppercase tracking-wide">Note</span>
        {!isReadOnly && (
          <div className="ml-auto flex items-center gap-1">
            {NOTE_COLOR_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => handleColorChange(key)}
                title={NOTE_COLORS[key].label}
                className={`nodrag w-3 h-3 rounded-full transition-transform hover:scale-125 ${
                  key === colorKey ? 'ring-2 ring-offset-1 ring-offset-transparent' : 'opacity-70'
                }`}
                style={{ backgroundColor: NOTE_COLORS[key].solid, ['--tw-ring-color']: NOTE_COLORS[key].solid }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={isReadOnly}
        placeholder="Write a note..."
        className="nodrag nowheel field-inline flex-1 w-full resize-none bg-transparent px-2.5 pb-2.5 text-sm leading-snug text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden disabled:cursor-not-allowed"
      />
    </div>
  );
}

export default memo(NoteNode);
