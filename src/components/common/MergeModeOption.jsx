/**
 * MergeModeOption - the "keep existing data" checkbox every import modal
 * shares (database import in ImportDBModal, Documents "Import from JSON" /
 * "Import from Base64"): same control, markup and placement; the host
 * supplies the label and the hint under it. Theme tokens only.
 */
export default function MergeModeOption({ checked, disabled = false, onChange, label, hint, testId = 'merge-mode-option' }) {
  return (
    <label className="flex items-start gap-3 p-3 border border-os-input-border cursor-pointer hover:bg-os-card-secondary transition-colors" data-testid={testId}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-blue-600"
      />
      <span>
        <span className="block text-sm font-medium text-os-text-primary">{label}</span>
        {hint && (
          <span className="block text-xs text-os-text-secondary mt-1">{hint}</span>
        )}
      </span>
    </label>
  );
}
