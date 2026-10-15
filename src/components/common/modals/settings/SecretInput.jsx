import { useSecretStatus } from './secretStatusContext';
import { FIELD_MONO_CLASS } from './ui';

/**
 * A password field for a write-only secret: shows whether one is stored,
 * lets the user type a replacement, or clear it. Shares the look of every
 * other Settings field (ui.jsx).
 */
export function SecretInput({ settingKey, value, onChange, placeholder, className = '', inputProps = {} }) {
  const { stored, onClear } = useSecretStatus();
  const isStored = !!stored?.[settingKey];
  return (
    <div className="flex items-stretch gap-2">
      <input
        type="password"
        value={value || ''}
        onChange={onChange}
        placeholder={isStored ? 'Saved. Leave blank to keep it, or type a new value to replace it' : placeholder}
        autoComplete="new-password"
        className={`${FIELD_MONO_CLASS} ${className}`}
        {...inputProps}
      />
      {isStored && onClear && (
        <button
          type="button"
          onClick={() => onClear(settingKey)}
          className="sc-btn sc-btn-secondary px-2 text-xs text-os-text-secondary hover:text-red-600 dark:hover:text-red-400 bg-os-modal border border-os-input-border rounded-sm shrink-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40"
          title="Forget the stored value"
        >
          Clear
        </button>
      )}
    </div>
  );
}
