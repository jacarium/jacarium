import { memo } from 'react';
import { GitBranch } from 'lucide-react';
import { NodeHeader, DataInputPin, ExecOutputPinWithLabel, NodeError, NodeHint } from './NodeComponents';
import { nodeShellClass } from './nodeStyles';

function BranchNode({ data, isConnectable }) {
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={GitBranch}
        title="Branch"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <DataInputPin
          isConnectable={isConnectable}
          label="Boolean condition"
        />

        <NodeHint className="my-2">💡 Connect a boolean value (true/false) or comparison result</NodeHint>

        <NodeError error={data.error} className="mt-2" />

        {/* Execution Output Pins - TRUE/FALSE */}
        <div className="flex flex-col gap-2 mt-3">
          <ExecOutputPinWithLabel id="true" label={<span className="text-green-600 font-medium">TRUE</span>} isConnectable={isConnectable} />
          <ExecOutputPinWithLabel id="false" label={<span className="text-red-600 font-medium">FALSE</span>} isConnectable={isConnectable} />
        </div>
      </div>
    </div>
  );
}

export default memo(BranchNode);
