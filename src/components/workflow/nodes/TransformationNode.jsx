import { memo } from 'react';
import { Code } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin, NodeError } from './NodeComponents';
import { NodeTextArea } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';

function TransformationNode({ data, isConnectable }) {
  const [code, setCode] = useNodeField(data, 'code', '// Transform input data\nreturn input;');
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[350px]' })}>
      <NodeHeader
        icon={Code}
        title="Transform"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={true}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <DataInputPin
          isConnectable={isConnectable}
          label={<>Data as <code className="bg-gray-100 px-1 rounded-sm">input</code> variable</>}
        />

        <NodeTextArea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={data.isReadOnly}
          placeholder="// Transform input data\nreturn input.filter(x => x.active);"
          className="h-48 font-mono disabled:cursor-not-allowed"
        />
        <NodeError error={data.error} className="mt-2" />

        <DataOutputPin isConnectable={isConnectable} label="Transformed data" />
      </div>
    </div>
  );
}

export default memo(TransformationNode);
