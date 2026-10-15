import { memo, useState } from 'react';
import { Play, Plus, X } from 'lucide-react';
import { Position } from 'reactflow';
import { NodeHeader, DataPinHandle } from './NodeComponents';
import { nodeShellClass } from './nodeStyles';
import { useNotifications } from '../../../contexts/NotificationContext';
import { useFollowExternalValue } from './nodeHooks';

function BeginPlayNode({ data, isConnectable }) {
  const isShared = data.isShared || false;
  const status = data.status;
  const isReadOnly = data.isReadOnly || false;

  const { addNotification } = useNotifications();

  // Named inputs: each one gets an input-<name> pin (wire a default value in)
  // and an output-<name> pin (read the value downstream)
  const [inputs, setInputs] = useState(data.inputs || {});
  const [newInputName, setNewInputName] = useState('');

  useFollowExternalValue(data.inputs, inputs, (external) => setInputs(external || {}));

  const updateInputs = (updatedInputs) => {
    setInputs(updatedInputs);
    if (data.onChange) {
      data.onChange({ inputs: updatedInputs });
    }
  };

  const handleAddInput = () => {
    if (!newInputName.trim() || isReadOnly) return;

    if (inputs[newInputName]) {
      addNotification({
        type: 'alert',
        title: 'Duplicate Input',
        message: 'Input name already exists'
      });
      return;
    }

    updateInputs({
      ...inputs,
      [newInputName]: { type: 'string', default: '' }
    });
    setNewInputName('');
  };

  const handleRemoveInput = (inputName) => {
    if (isReadOnly) return;

    const updatedInputs = { ...inputs };
    delete updatedInputs[inputName];
    updateInputs(updatedInputs);
  };

  const inputNames = Object.keys(inputs);

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={Play}
        title="Begin Play"
        isShared={isShared}
        status={status}
        hasExecInput={false}
        hasExecOutput={true}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <div className="text-xs text-os-text-muted mb-2">
          Workflow entry point
        </div>

        {/* Input/Output Pins */}
        {inputNames.length > 0 && (
          <div className="space-y-1 mb-3">
            <div className="text-xs font-medium text-os-text-secondary">Input/Output:</div>
            {inputNames.map((inputName) => (
              <div key={inputName} className="workflow-pin-row flex items-center justify-between gap-2">
                {/* Input pin on the left border, output pin on the right border */}
                <DataPinHandle type="target" position={Position.Left} id={`input-${inputName}`} isConnectable={isConnectable} />
                <span className="text-xs text-os-text-primary ml-1">{inputName}</span>

                {!isReadOnly && (
                  <button
                    onClick={() => handleRemoveInput(inputName)}
                    className="nodrag p-0.5 hover:bg-red-50 rounded-sm"
                    title="Remove input"
                  >
                    <X size={12} className="text-red-600" />
                  </button>
                )}
                <DataPinHandle type="source" position={Position.Right} id={`output-${inputName}`} isConnectable={isConnectable} />
              </div>
            ))}
          </div>
        )}

        {/* Add Input */}
        {!isReadOnly && (
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={newInputName}
                onChange={(e) => setNewInputName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddInput()}
                placeholder="Input name..."
                className="nodrag flex-1 px-2 py-1 text-xs border border-os-input-border rounded-sm focus:outline-hidden focus:border-purple-500 bg-os-input-bg text-os-text-primary"
              />
              <button
                onClick={handleAddInput}
                disabled={!newInputName.trim()}
                className="nodrag p-1 bg-purple-600 text-white rounded-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Add input"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(BeginPlayNode);
