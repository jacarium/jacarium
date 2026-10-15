import { memo } from 'react';
import { Clock } from 'lucide-react';
import { NodeHeader, DataInputPin } from './NodeComponents';
import { NodeField, NodeTextInput } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';

function DelayNode({ data, isConnectable }) {
  const [duration, setDuration] = useNodeField(data, 'duration', 1000);
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={Clock}
        title="Delay"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={true}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <DataInputPin isConnectable={isConnectable} label="Duration (ms) from input" />

        <NodeField label="Default Duration (milliseconds)">
          <NodeTextInput
            type="number"
            value={duration}
            onChange={(e) => setDuration(parseInt(e.target.value) || 0)}
            disabled={data.isReadOnly}
            min="0"
            step="100"
            placeholder="1000"
          />
        </NodeField>
        <div className="text-xs text-os-text-muted">
          Default: {duration}ms ({duration / 1000}s)
        </div>
      </div>
    </div>
  );
}

export default memo(DelayNode);
