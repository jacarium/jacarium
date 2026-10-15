import { useEffect, useRef } from 'react';

/** The TAB completion candidates, popped up above the terminal input. */
export default function SSHCompletionList({ completions, selectedIndex, onSelect }) {
  const listRef = useRef(null);

  // Scroll selected completion into view
  useEffect(() => {
    if (completions.length > 0 && listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex + 1]; // +1 for header
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedIndex, completions.length]);

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-3 right-3 mb-1 bg-os-card border border-os-border rounded-sm shadow-lg max-h-64 overflow-y-auto z-50"
    >
      <div className="text-xs text-os-text-muted px-3 py-1 border-b border-os-border bg-os-card-secondary">
        Press ↑↓ to navigate, Enter to select, Tab to cycle, Esc to cancel
      </div>
      {completions.map((completion, index) => (
        <button
          key={index}
          onClick={() => onSelect(completion)}
          className={`w-full text-left px-3 py-1.5 font-mono text-xs transition-colors ${
 index === selectedIndex
 ?'bg-os-blue text-white'
 :'text-os-text-primary hover:bg-os-card-secondary'
 }`}
        >
          {completion}
        </button>
      ))}
    </div>
  );
}
