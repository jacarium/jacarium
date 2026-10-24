import { memo } from 'react';
import { Position } from 'reactflow';
import { GitMerge, Trash2 } from 'lucide-react';
import { NodeHeader, DataInputPin, ExecPinHandle, NodeError } from './NodeComponents';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

function SwitchNode({ data, isConnectable }) {
  const [cases, setCases] = useNodeField(data, 'cases', nodeFieldDefault('switch', 'cases'));
  const isReadOnly = data.isReadOnly || false;
  const isShared = data.isShared || false;
  const status = data.status;

  const handleCaseChange = (index, value) => {
    setCases(cases.map((c, i) => (i === index ? { ...c, value } : c)));
  };

  const handleAddCase = () => {
    setCases([...cases, { value: `case${cases.length + 1}` }]);
  };

  const handleRemoveCase = (index) => {
    if (cases.length <= 1) return;
    setCases(cases.filter((_, i) => i !== index));
  };

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[280px]' })}>
      <NodeHeader
        icon={GitMerge}
        title="Switch"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <DataInputPin
          isConnectable={isConnectable}
          label="Value to match against cases"
        />

        {cases.map((caseItem, index) => (
          <div key={index} className="workflow-pin-row flex items-center gap-2">
            <input
              type="text"
              value={caseItem.value}
              onChange={(e) => handleCaseChange(index, e.target.value)}
              disabled={isReadOnly}
              placeholder={`case${index + 1}`}
              className="nodrag flex-1 px-2 py-1 text-xs border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-purple-500 font-mono disabled:bg-os-card-secondary bg-os-input-bg text-os-text-primary"
            />
            {cases.length > 1 && !isReadOnly && (
              <button
                onClick={() => handleRemoveCase(index)}
                className="btn btn-danger-ghost nodrag p-1"
                title="Remove case"
              >
                <Trash2 size={12} />
              </button>
            )}
            {/* Execution output pin for this case, on the right border */}
            <ExecPinHandle type="source" position={Position.Right} id={`case-${index}`} isConnectable={isConnectable} />
          </div>
        ))}
        {!isReadOnly && (
          <button
            onClick={handleAddCase}
            className="btn btn-brand-ghost nodrag w-full px-2 py-1 text-xs flex items-center justify-center gap-1"
          >
            Add Case
          </button>
        )}
        <NodeError error={data.error} />

        {/* Default execution output */}
        <div className="workflow-pin-row flex items-center justify-end mt-2 pt-2 border-t">
          <span className="text-xs text-os-text-muted mr-1">DEFAULT</span>
          <ExecPinHandle type="source" position={Position.Right} id="default" isConnectable={isConnectable} />
        </div>
      </div>
    </div>
  );
}

export default memo(SwitchNode);
