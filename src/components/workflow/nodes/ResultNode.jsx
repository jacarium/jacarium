import { memo, useState } from 'react';
import { Download } from 'lucide-react';
import { NodeHeader, DataInputPin } from './NodeComponents';
import { OutputActions } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useCopyToClipboard } from './nodeHooks';
import { formatNodeValue } from '../workflowNodeUtils';

function ResultNode({ data, isConnectable }) {
  const isShared = data.isShared || false;
  const status = data.status;
  const outputValue = data.outputValue;
  const { copied, copy } = useCopyToClipboard();
  const [expanded, setExpanded] = useState(false);
  const hasValue = outputValue !== undefined && outputValue !== null;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[300px]' })}>
      <NodeHeader
        icon={Download}
        title="Result"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <DataInputPin isConnectable={isConnectable} label="Data" />

        {hasValue ? (
          <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-medium text-os-text-secondary">Value:</div>
              <OutputActions
                expanded={expanded}
                onToggleExpanded={() => setExpanded(!expanded)}
                copied={copied}
                onCopy={() => copy(formatNodeValue(outputValue))}
              />
            </div>
            <pre className={`nodrag nowheel select-text cursor-text text-xs font-mono overflow-auto bg-os-card-secondary p-2 rounded border border-os-border ${
              expanded ? 'max-h-96' : 'max-h-32'
            }`} style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
              {formatNodeValue(outputValue)}
            </pre>
          </div>
        ) : (
          <div className="mt-2 text-xs text-os-text-muted italic text-center">
            Connect data source and execute workflow to see result
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ResultNode);
