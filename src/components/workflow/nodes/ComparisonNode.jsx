import { memo } from 'react';
import { Scale } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin, NodeError } from './NodeComponents';
import { NodeField, NodeSelect } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';

const OPERATORS = [
  { value: '>', label: '> (Greater Than)' },
  { value: '<', label: '< (Less Than)' },
  { value: '==', label: '== (Equal To)' },
  { value: '!=', label: '!= (Not Equal)' },
  { value: '>=', label: '>= (Greater or Equal)' },
  { value: '<=', label: '<= (Less or Equal)' }
];

function ComparisonNode({ data, isConnectable }) {
  const [operator, setOperator] = useNodeField(data, 'operator', '>');
  const isShared = data.isShared || false;
  const status = data.status;
  const result = data.result; // The comparison result

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={Scale}
        title="Comparison"
        isShared={isShared}
        status={status}
        hasExecInput={false}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <DataInputPin isConnectable={isConnectable} label="Left value" targetHandle="left-in" />

        <NodeField label="Operator">
          <NodeSelect
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            disabled={data.isReadOnly}
          >
            {OPERATORS.map(op => (
              <option key={op.value} value={op.value}>{op.label}</option>
            ))}
          </NodeSelect>
        </NodeField>

        <DataInputPin isConnectable={isConnectable} label="Right value" targetHandle="right-in" />

        {/* Show result if available */}
        {result !== undefined && result !== null && (
          <div className={`text-xs font-semibold px-2 py-1.5 rounded ${
            result ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
          }`}>
            Result: {result ? 'True' : 'False'}
          </div>
        )}

        <NodeError error={data.error} className="dark:text-red-300 dark:bg-red-900/20" />

        <DataOutputPin isConnectable={isConnectable} label="Boolean result" />
      </div>
    </div>
  );
}

export default memo(ComparisonNode);
