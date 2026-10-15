import { useState } from 'react';
import { X, Save } from 'lucide-react';
import { getAllCategoryIcons } from '../../utils/categoryIcons';

/**
 * IconPickerModal - Modal for selecting category icons
 * Styled to match SaveTemplateModal from JQL Builder
 */
export default function IconPickerModal({ isOpen, onClose, onSelect, currentIcon = null }) {
  const [selectedIcon, setSelectedIcon] = useState(currentIcon);
  const icons = getAllCategoryIcons();

  if (!isOpen) return null;

  const handleSelect = () => {
    onSelect(selectedIcon);
    onClose();
  };

  const handleRemoveIcon = () => {
    onSelect(null);
    onClose();
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && selectedIcon) {
      handleSelect();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 font-text"
      onClick={onClose}
    >
      <div
        className="bg-os-modal shadow-lg max-w-lg w-full border border-os-border rounded-sm max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyPress}
      >
        {/* Header */}
        <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
            Select Category Icon
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-sidebar-hover transition-colors"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 bg-os-modal">
          {/* Icon Selection */}
          <div>
            <label className="block text-xs font-text text-os-text-primary mb-3 uppercase tracking-wide">
              Icon
            </label>
            <div className="grid grid-cols-4 gap-3">
              {icons.map(({ name, Icon, label }) => (
                <button
                  key={name}
                  onClick={() => setSelectedIcon(name)}
                  className={`
 flex flex-col items-center justify-center p-4 border transition-all bg-os-modal
 ${selectedIcon === name
 ?'border-os-blue bg-blue-50 dark:bg-blue-900/20'
 :'border-os-input-border hover:border-os-blue hover:bg-os-card-secondary'
 }
`}
                  title={label}
                >
                  <Icon
                    size={24}
                    className={selectedIcon === name ?'text-os-blue':'text-os-text-muted'}
                  />
                  <span className={`text-xs mt-2 ${selectedIcon === name ?'text-os-blue font-medium':'text-os-text-muted'}`}>
                    {label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Info */}
          <div className="bg-os-card-secondary border border-os-border rounded-sm p-3">
            <p className="text-xs text-os-text-secondary">
              <strong>Tip:</strong> Select an icon to visually identify this category. The icon will replace the chevron when the category is collapsed.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-between sticky bottom-0">
          <button
            onClick={handleRemoveIcon}
            className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
          >
            Remove Icon
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSelect}
              disabled={!selectedIcon}
              className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
            >
              Save Icon
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
