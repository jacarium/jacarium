import { useState } from 'react';
import { X } from 'lucide-react';

export default function MultiValueInput({ values, onChange, options, placeholder }) {
  const [inputValue, setInputValue] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);

  // Parse values from comma-separated string
  const valueList = values
    ? values.split(',').map(v => v.trim()).filter(v => v)
    : [];

  function addValue(value) {
    const trimmed = value.trim();
    if (!trimmed || valueList.includes(trimmed)) return;

    const newValues = [...valueList, trimmed];
    onChange(newValues.join(', '));
    setInputValue('');
    setShowDropdown(false);
  }

  function removeValue(value) {
    const newValues = valueList.filter(v => v !== value);
    onChange(newValues.join(', '));
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      addValue(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && valueList.length > 0) {
      removeValue(valueList[valueList.length - 1]);
    }
  }

  function handleOptionClick(option) {
    addValue(option.value);
  }

  const filteredOptions = options
    ? options.filter(opt =>
        !valueList.includes(opt.value) &&
        opt.label.toLowerCase().includes(inputValue.toLowerCase())
      )
    : [];

  return (
    <div className="relative">
      <div className="w-full min-h-[42px] px-3 py-1.5 border border-os-input-border focus-within:ring-2 focus-within:ring-os-blue focus-within:border-os-blue bg-os-input-bg">
        <div className="flex flex-wrap gap-1.5 items-center">
          {valueList.map((value, index) => (
            <span
              key={index}
              className="inline-flex items-center gap-1 px-2 py-1 bg-os-blue text-white text-xs font-medium"
            >
              {value}
              <button
                onClick={() => removeValue(value)}
                className="hover:bg-os-blue-hover p-0.5"
                type="button"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setShowDropdown(options && options.length > 0)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
            placeholder={valueList.length === 0 ? placeholder || 'Type and press Enter...' : ''}
            className="field-inline flex-1 min-w-[120px] outline-hidden text-sm text-os-text-primary placeholder:text-os-text-muted bg-transparent"
          />
        </div>
      </div>

      {/* Dropdown for options */}
      {showDropdown && filteredOptions.length > 0 && (
        <div className="absolute z-10 w-full mt-1 bg-os-card border border-os-input-border shadow-2xl max-h-48 overflow-y-auto">
          {filteredOptions.map((option, index) => (
            <button
              key={index}
              type="button"
              onClick={() => handleOptionClick(option)}
              className="w-full px-3 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary hover:text-os-blue transition-colors"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
