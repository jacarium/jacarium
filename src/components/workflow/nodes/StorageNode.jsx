import { memo } from 'react';
import { Database } from 'lucide-react';
import { NodeHeader, DataInputPin, NodeError, NodeHint } from './NodeComponents';
import { NodeField, NodeTextInput, NodeValuePreview } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

function StorageNode({ data, isConnectable }) {
  const [variableName, setVariableName] = useNodeField(data, 'variableName', nodeFieldDefault('storage', 'variableName'));
  const isShared = data.isShared || false;
  const status = data.status;
  const savedCount = data.savedCount || 0;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[300px]' })}>
      <NodeHeader
        icon={Database}
        title="Set Variable"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={true}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <DataInputPin isConnectable={isConnectable} label="Data to store" />

        <NodeField label="Variable Name">
          <NodeTextInput
            value={variableName}
            onChange={(e) => setVariableName(e.target.value)}
            disabled={data.isReadOnly}
            placeholder="e.g., apiResponse, users, data"
            className="font-mono"
          />
        </NodeField>

        <NodeHint>💡 Store value in a variable. Retrieve with Get Variable node.</NodeHint>

        {savedCount > 0 && (
          <div className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded-sm">
            ✓ Stored as <code className="font-mono font-semibold">{variableName}</code>
          </div>
        )}

        <NodeValuePreview label="Stored Data:" value={data.storedData} />

        <NodeError error={data.error} />
      </div>
    </div>
  );
}

export default memo(StorageNode);
