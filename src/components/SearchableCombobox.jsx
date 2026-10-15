import { useState, useEffect, useRef } from 'react';
import { Search, ChevronDown, Loader2 } from 'lucide-react';
import { debounce } from '../services/jiraApi';

export default function SearchableCombobox({
  value,
  onChange,
  onSearch,
  options = [],
  placeholder = 'Search...',
  disabled = false,
  className = '',
  loading = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filteredOptions, setFilteredOptions] = useState(options);
  const wrapperRef = useRef(null);

  // Derived directly from props instead of the previous state + sync effect
  const selectedOption = options.find(opt => opt.value === value);
  const displayValue = selectedOption ? selectedOption.label : '';

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Update filtered options when options change
  useEffect(() => {
    console.log('[SearchableCombobox] Options changed:', {
      optionsLength: options.length,
      firstOption: options[0],
      placeholder,
    });
    // Intentional prop-to-state sync: the filtered list resets whenever the
    // upstream options change (the debounced search narrows it locally).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilteredOptions(options);
  }, [options, placeholder]);

  // Reset search term when value changes from outside (like on import).
  // isOpen is deliberately only a guard, not a trigger: closing the
  // dropdown should not clear what the user typed.
  useEffect(() => {
    if (value && !isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchTerm('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Debounced search handler
  const debouncedSearch = useRef(
    debounce((term) => {
      if (onSearch) {
        onSearch(term);
      } else {
        // Local filtering
        const filtered = options.filter(opt =>
          opt.label.toLowerCase().includes(term.toLowerCase()) ||
          opt.value.toLowerCase().includes(term.toLowerCase())
        );
        setFilteredOptions(filtered);
      }
    }, 300)
  ).current;

  function handleSearchChange(e) {
    const term = e.target.value;
    setSearchTerm(term);
    debouncedSearch(term);
  }

  function handleSelect(option) {
    onChange(option.value);
    setSearchTerm('');
    setIsOpen(false);
  }

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm text-left flex items-center justify-between disabled:opacity-50 disabled:cursor-not-allowed font-text bg-os-input-bg"
      >
        <span className={displayValue ?'text-os-text-primary':'text-os-text-muted'}>
          {displayValue || placeholder}
        </span>
        <ChevronDown size={16} className="text-os-text-muted" />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-os-input-bg border border-os-input-border shadow-2xl max-h-60 overflow-hidden">
          <div className="p-2 border-b border-os-border">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-os-text-muted" />
              <input
                type="text"
                value={searchTerm}
                onChange={handleSearchChange}
                placeholder="Type to search..."
                className="w-full pl-9 pr-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm font-text bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto">
            {loading ? (
              <div className="px-4 py-8 flex flex-col items-center justify-center text-sm text-os-text-secondary font-text">
                <Loader2 className="animate-spin text-os-blue mb-2" size={24} />
                <span>Loading projects from Jira...</span>
              </div>
            ) : filteredOptions.length === 0 ? (
              <div className="px-4 py-3 text-sm text-os-text-secondary text-center font-text">
                No results found
              </div>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleSelect(option)}
                    className={`w-full px-4 py-2 text-left text-sm hover:bg-os-card-secondary transition-colors font-text ${
 isSelected ?'bg-os-blue/5 text-os-blue' :'text-os-text-primary'
 }`}
                  >
                    <div className="font-medium">{option.label}</div>
                    {option.value !== option.label && (
                      <div className="text-xs text-os-text-secondary">{option.value}</div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
