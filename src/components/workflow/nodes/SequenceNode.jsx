import { memo } from 'react';
import { List, Plus, Trash2 } from 'lucide-react';
import { NodeHeader, ExecOutputPinWithLabel, NodeError } from './NodeComponents';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

const MIN_OUTPUTS = 1;
const MAX_OUTPUTS = 10;

function SequenceNode({ data, isConnectable }) {
  const [outputCount, setOutputCount] = useNodeField(data, 'outputCount', nodeFieldDefault('sequence', 'outputCount'));
  const isReadOnly = data.isReadOnly || false;
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={List}
        title="Sequence"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <div className="text-xs text-os-text-muted mb-2">
          Execute {outputCount} path{outputCount !== 1 ? 's' : ''} in sequence
        </div>

        <div className="flex items-center gap-2 mb-2">
          {!isReadOnly && (
            <>
              <button
                onClick={() => outputCount > MIN_OUTPUTS && setOutputCount(outputCount - 1)}
                disabled={outputCount <= MIN_OUTPUTS}
                className="nodrag p-1 hover:bg-red-50 rounded-sm text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Remove output"
              >
                <Trash2 size={14} />
              </button>
              <span className="text-xs text-os-text-secondary flex-1 text-center">
                {outputCount} output{outputCount !== 1 ? 's' : ''}
              </span>
              <button
                onClick={() => outputCount < MAX_OUTPUTS && setOutputCount(outputCount + 1)}
                disabled={outputCount >= MAX_OUTPUTS}
                className="nodrag p-1 hover:bg-green-50 rounded-sm text-green-600 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Add output"
              >
                <Plus size={14} />
              </button>
            </>
          )}
        </div>

        <NodeError error={data.error} />

        {/* Execution Output Pins */}
        <div className="flex flex-col gap-2 mt-2">
          {Array.from({ length: outputCount }).map((_, index) => (
            <ExecOutputPinWithLabel
              key={index}
              id={`output-${index}`}
              label={`Then ${index}`}
              isConnectable={isConnectable}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(SequenceNode);
