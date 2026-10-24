import { memo, useState } from 'react';
import { Eye } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin } from './NodeComponents';
import { OutputActions } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useCopyToClipboard } from './nodeHooks';
import { formatNodeValue } from '../workflowNodeUtils';

const cellText = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value));

/** Rows of objects as a table with one column per key of the first row. */
function ArrayTable({ rows }) {
  const keys = Object.keys(rows[0] || {});
  return (
    <div className="nodrag nowheel select-text cursor-text overflow-auto max-h-64">
      <table className="text-xs w-full border-collapse">
        <thead className="bg-gray-100 sticky top-0">
          <tr>
            {keys.map(key => (
              <th key={key} className="border px-2 py-1 text-left font-semibold">
                {key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-os-card-secondary">
              {keys.map(key => (
                <td key={key} className="border px-2 py-1">
                  {cellText(row[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An object as a key/value table. */
function ObjectTable({ object }) {
  return (
    <div className="nodrag nowheel select-text cursor-text overflow-auto max-h-64">
      <table className="text-xs w-full border-collapse">
        <thead className="bg-gray-100">
          <tr>
            <th className="border px-2 py-1 text-left font-semibold w-1/3">Key</th>
            <th className="border px-2 py-1 text-left font-semibold">Value</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(object).map(([key, value]) => (
            <tr key={key} className="hover:bg-os-card-secondary">
              <td className="border px-2 py-1 font-mono">{key}</td>
              <td className="border px-2 py-1">{cellText(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VisualizerNode({ data, isConnectable }) {
  const [viewMode, setViewMode] = useState(data.viewMode || 'json'); // 'json' or 'table'
  const displayData = data.data || null;
  const isReadOnly = data.isReadOnly || false;
  const isShared = data.isShared || false;
  const status = data.status;
  const { copied, copy } = useCopyToClipboard();
  const [expanded, setExpanded] = useState(false);

  const renderJSON = () => {
    if (displayData === null || displayData === undefined) {
      return <div className="text-gray-400 text-xs">No data to display</div>;
    }
    if (Array.isArray(displayData) && displayData.length === 0) {
      return <div className="text-gray-400 text-xs">Empty array</div>;
    }
    if (typeof displayData === 'object' && Object.keys(displayData).length === 0) {
      return <div className="text-gray-400 text-xs">Empty object</div>;
    }

    // A structured-cloned transform result may hold cycles JSON cannot express
    let text;
    try {
      text = JSON.stringify(displayData, null, 2);
    } catch {
      return <div className="text-red-600 text-xs">Invalid JSON data</div>;
    }

    return (
      <div className="space-y-1">
        <div className="flex items-center justify-end">
          <OutputActions
            expanded={expanded}
            onToggleExpanded={() => setExpanded(!expanded)}
            copied={copied}
            onCopy={() => copy(formatNodeValue(displayData))}
          />
        </div>
        <pre className={`nodrag nowheel cursor-text text-xs font-mono overflow-auto bg-os-card-secondary p-2 rounded select-text ${
          expanded ? 'max-h-96' : 'max-h-64'
        }`} style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
          {text}
        </pre>
      </div>
    );
  };

  const renderTable = () => {
    if (!displayData) {
      return <div className="text-gray-400 text-xs">No data to display</div>;
    }
    if (Array.isArray(displayData)) {
      if (displayData.length === 0) {
        return <div className="text-gray-400 text-xs">Empty array</div>;
      }
      return <ArrayTable rows={displayData} />;
    }
    if (typeof displayData === 'object') {
      return <ObjectTable object={displayData} />;
    }
    return <div className="text-xs">{String(displayData)}</div>;
  };

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[400px]' })}>
      <NodeHeader
        icon={Eye}
        title="Visualizer"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={true}
        isConnectable={isConnectable}
      >
        {/* View mode toggle */}
        <div className="ml-auto flex gap-1">
          <button
            onClick={() => setViewMode('json')}
            disabled={isReadOnly}
            className={`nodrag px-2 py-0.5 text-xs ${
              viewMode === 'json'
                ? 'btn btn-brand'
                : 'btn btn-secondary'
            } disabled:opacity-50`}
          >
            JSON
          </button>
          <button
            onClick={() => setViewMode('table')}
            disabled={isReadOnly}
            className={`nodrag px-2 py-0.5 text-xs flex items-center gap-1 ${
              viewMode === 'table'
                ? 'btn btn-brand'
                : 'btn btn-secondary'
            } disabled:opacity-50`}
          >
            Table
          </button>
        </div>
      </NodeHeader>

      {/* Content */}
      <div className="p-3">
        <DataInputPin isConnectable={isConnectable} label="Data to display" />

        {/* Show data if it exists, regardless of status */}
        {displayData !== null && displayData !== undefined ? (
          viewMode === 'json' ? renderJSON() : renderTable()
        ) : status === 'processing' ? (
          <div className="text-xs text-gray-400 italic text-center py-4">
            Waiting for data...
          </div>
        ) : (
          <div className="text-xs text-gray-400 italic text-center py-4">
            Connect data source and execute workflow to visualize data
          </div>
        )}

        <DataOutputPin isConnectable={isConnectable} label="Pass-through" />
      </div>
    </div>
  );
}

export default memo(VisualizerNode);
