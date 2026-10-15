import { memo } from 'react';
import { Braces } from 'lucide-react';
import { NodeHeader, DataOutputPin } from './NodeComponents';
import { NodeTextArea } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';

function ObjectVariableNode({ data, isConnectable }) {
  const [value, setValue] = useNodeField(data, 'value', '{}');
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[300px]' })}>
      <NodeHeader
        icon={Braces}
        title="Object"
        isShared={isShared}
        status={status}
        hasExecInput={false}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <NodeTextArea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={data.isReadOnly}
          placeholder='{"key": "value"}'
          className="h-32 font-mono"
        />

        <DataOutputPin isConnectable={isConnectable} label="Parsed JSON" />
      </div>
    </div>
  );
}

export default memo(ObjectVariableNode);
