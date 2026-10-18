import { memo } from 'react';
import { FileText } from 'lucide-react';
import { NodeHeader, DataOutputPin } from './NodeComponents';
import { NodeTextArea } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

function TextVariableNode({ data, isConnectable }) {
  const [value, setValue] = useNodeField(data, 'value', nodeFieldDefault('text', 'value'));
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[300px]' })}>
      <NodeHeader
        icon={FileText}
        title="Text"
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
          placeholder="Enter text content..."
          className="h-32"
        />

        <DataOutputPin isConnectable={isConnectable} label="Text content" />
      </div>
    </div>
  );
}

export default memo(TextVariableNode);
