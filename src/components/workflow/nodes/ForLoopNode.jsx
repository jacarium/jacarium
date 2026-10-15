import { memo } from 'react';
import { IterationCw } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin, ExecOutputPinWithLabel, NodeError } from './NodeComponents';
import { nodeShellClass } from './nodeStyles';

function ForLoopNode({ data, isConnectable }) {
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={IterationCw}
        title="For Loop"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <div className="text-xs text-os-text-muted mb-2">
          Iterate over array items
        </div>

        <DataInputPin isConnectable={isConnectable} label="Array" />

        <NodeError error={data.error} className="mt-2" />

        {/* Data Output */}
        <div className="mt-3">
          <DataOutputPin isConnectable={isConnectable} label="Item" />
        </div>

        {/* Execution Output Pins */}
        <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-os-border">
          <ExecOutputPinWithLabel id="loop-body" label="Loop Body" isConnectable={isConnectable} />
          <ExecOutputPinWithLabel id="completed" label="Completed" isConnectable={isConnectable} />
        </div>
      </div>
    </div>
  );
}

export default memo(ForLoopNode);
