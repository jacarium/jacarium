import { memo } from 'react';
import { ListPlus } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin, NodeError } from './NodeComponents';
import { NodeField, NodeTextInput } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

function MakeArrayNode({ data, isConnectable }) {
  const [delimiter, setDelimiter] = useNodeField(data, 'delimiter', nodeFieldDefault('makearray', 'delimiter'));
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={ListPlus}
        title="Make Array"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={true}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <DataInputPin isConnectable={isConnectable} label="String" />

        <NodeField label="Delimiter" className="mt-2">
          <NodeTextInput
            value={delimiter}
            onChange={(e) => setDelimiter(e.target.value)}
            disabled={data.isReadOnly}
            placeholder=","
          />
        </NodeField>

        <NodeError error={data.error} className="mt-2" />

        <DataOutputPin isConnectable={isConnectable} label="Array" />
      </div>
    </div>
  );
}

export default memo(MakeArrayNode);
