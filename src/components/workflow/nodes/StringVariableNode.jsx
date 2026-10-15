import { memo } from 'react';
import { Type } from 'lucide-react';
import { NodeHeader, DataOutputPin } from './NodeComponents';
import { NodeTextInput } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';

function StringVariableNode({ data, isConnectable }) {
  const [value, setValue] = useNodeField(data, 'value', '');
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={Type}
        title="String"
        isShared={isShared}
        status={status}
        hasExecInput={false}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <NodeTextInput
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={data.isReadOnly}
          placeholder="Enter text..."
        />

        <DataOutputPin isConnectable={isConnectable} label="String value" />
      </div>
    </div>
  );
}

export default memo(StringVariableNode);
