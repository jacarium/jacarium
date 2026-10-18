import { memo } from 'react';
import { FileText } from 'lucide-react';
import { NodeHeader, DataOutputPin, NodeHint } from './NodeComponents';
import { NodeField, NodeTextInput, NodeValuePreview } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

function VariableReferenceNode({ data, isConnectable }) {
  const [variableName, setVariableName] = useNodeField(data, 'variableName', nodeFieldDefault('variablereference', 'variableName'));
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={FileText}
        title="Get Variable"
        isShared={isShared}
        status={status}
        hasExecInput={false}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <NodeField label="Variable Name">
          <NodeTextInput
            value={variableName}
            onChange={(e) => setVariableName(e.target.value)}
            disabled={data.isReadOnly}
            placeholder="e.g., apiResponse, users"
            className="font-mono"
          />
        </NodeField>

        <NodeHint>💡 Reference data stored in Storage nodes</NodeHint>

        <NodeValuePreview label="Value:" value={data.storedData} />

        <DataOutputPin isConnectable={isConnectable} label="Variable value" />
      </div>
    </div>
  );
}

export default memo(VariableReferenceNode);
