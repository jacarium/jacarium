import { memo } from 'react';
import { ToggleLeft } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin } from './NodeComponents';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

function BooleanVariableNode({ data, isConnectable }) {
  const [value, setValue] = useNodeField(data, 'value', nodeFieldDefault('boolean', 'value'));
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[200px]' })}>
      <NodeHeader
        icon={ToggleLeft}
        title="Boolean"
        isShared={isShared}
        status={status}
        hasExecInput={false}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <DataInputPin isConnectable={isConnectable} label="Condition (optional)" />

        <div className="mt-2 text-xs text-os-text-secondary dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20 px-2 py-1.5 rounded-sm border border-blue-200 dark:border-blue-800">
          💡 Connect data input to use dynamic value, or toggle manually
        </div>

        <button
          onClick={() => setValue(!value)}
          disabled={data.isReadOnly}
          className={`nodrag w-full px-3 py-2 text-sm border-2 transition-colors mt-2 ${
            value
              ? 'bg-green-50 border-green-500 text-green-700'
              : 'bg-os-card-secondary border-os-input-border text-os-text-secondary'
          } disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-sm`}
        >
          {value ? 'True' : 'False'}
        </button>

        <DataOutputPin isConnectable={isConnectable} label="Boolean value" />
      </div>
    </div>
  );
}

export default memo(BooleanVariableNode);
