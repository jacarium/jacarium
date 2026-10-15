import { memo, useState } from 'react';
import { Hash } from 'lucide-react';
import { NodeHeader, DataOutputPin } from './NodeComponents';
import { NodeTextInput } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useFollowExternalValue } from './nodeHooks';

function IntegerVariableNode({ data, isConnectable }) {
  const [value, setValue] = useState(data.value !== undefined ? data.value : '');
  const isReadOnly = data.isReadOnly || false;
  const isShared = data.isShared || false;
  const status = data.status;
  // The field may show text the stored number does not ("" and "-" are
  // stored as 0), so an outside change (undo/redo) is told apart from our
  // own by what we last pushed, not by what is shown
  const [lastPushed, setLastPushed] = useState(data.value);
  useFollowExternalValue(data.value, lastPushed, (external) => {
    setLastPushed(external);
    setValue(external !== undefined ? external : '');
  });

  const pushValue = (next) => {
    setLastPushed(next);
    if (data.onChange) {
      data.onChange({ value: next });
    }
  };

  // The field shows what was typed (so "" and a lone "-" stay editable) while
  // the stored value is always an integer: 0 for those two, otherwise the
  // parsed number. Anything that does not parse is ignored.
  const handleValueChange = (e) => {
    if (isReadOnly) return;
    const inputValue = e.target.value;

    if (inputValue === '' || inputValue === '-') {
      setValue(inputValue);
      pushValue(0);
    } else {
      const newValue = parseInt(inputValue);
      if (!isNaN(newValue)) {
        setValue(newValue);
        pushValue(newValue);
      }
    }
  };

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[200px]' })}>
      <NodeHeader
        icon={Hash}
        title="Integer"
        isShared={isShared}
        status={status}
        hasExecInput={false}
        hasExecOutput={false}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3">
        <NodeTextInput
          value={value}
          onChange={handleValueChange}
          disabled={isReadOnly}
          placeholder="Enter number..."
        />

        <DataOutputPin isConnectable={isConnectable} label="Integer value" />
      </div>
    </div>
  );
}

export default memo(IntegerVariableNode);
