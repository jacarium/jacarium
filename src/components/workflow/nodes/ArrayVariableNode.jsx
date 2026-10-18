import { memo, useState } from 'react';
import { List } from 'lucide-react';
import { NodeHeader, DataOutputPin } from './NodeComponents';
import { NodeTextArea } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useFollowExternalValue } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

/** The parsed array when `text` is valid JSON array text, otherwise null. */
function parseArrayText(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ArrayVariableNode({ data, isConnectable }) {
  const [value, setValue] = useState(data.value || nodeFieldDefault('array', 'value'));
  const isReadOnly = data.isReadOnly || false;
  const isShared = data.isShared || false;
  const status = data.status;

  useFollowExternalValue(data.value, value, (external) => setValue(external ?? nodeFieldDefault('array', 'value')));

  // The text is always stored; a valid array is stored alongside it as
  // `arrayValue` (invalid JSON leaves the previous arrayValue untouched).
  const handleValueChange = (e) => {
    if (isReadOnly) return;
    const newValue = e.target.value;
    setValue(newValue);
    if (data.onChange) {
      const parsed = parseArrayText(newValue);
      data.onChange(parsed ? { value: newValue, arrayValue: parsed } : { value: newValue });
    }
  };

  const isValid = parseArrayText(value) !== null;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[250px]' })}>
      <NodeHeader
        icon={List}
        title="Array"
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
          onChange={handleValueChange}
          disabled={isReadOnly}
          placeholder='["item1", "item2", "item3"]'
          className="h-24 font-mono"
        />

        {!isValid && (
          <div className="text-xs text-red-600 mt-1">Invalid JSON array</div>
        )}

        <DataOutputPin isConnectable={isConnectable} label="Array value" />
      </div>
    </div>
  );
}

export default memo(ArrayVariableNode);
