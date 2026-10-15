
/**
 * ImportFooter - the action row every import modal shares (database import
 * in ImportDBModal, Documents "Import from JSON" / "Import from Base64"):
 *
 *   before the import:  [Cancel]  [Dry Run]  [<importLabel>]
 *   after the import:   [Close]   ([Reload App] when onReload is given)
 *
 * Same classes, order and busy/disabled states everywhere so the flows
 * look and behave alike. `busy` is 'dry-run' | 'import' | null.
 */
export default function ImportFooter({
  imported = false,
  busy = null,
  onCancel,
  onClose = onCancel,
  onReload = null,
  onDryRun = null,
  onImport,
  disabled = false,
  importLabel = 'Import',
  importingLabel = 'Importing...',
  dryRunTitle = 'Run the import without writing anything and show what would change',
  className = 'p-4 border-t border-os-border bg-os-modal flex items-center justify-end gap-3',
}) {
  const secondary = 'px-4 py-2 bg-os-modal border border-os-input-border rounded-sm text-os-text-primary text-sm font-medium hover:bg-os-card-secondary transition-colors';
  const primary = 'flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm font-medium hover:bg-os-blue-hover rounded-sm transition-colors';
  return (
    <div className={className} data-testid="import-footer">
      {imported ? (
        <>
          <button type="button" onClick={onClose} className={secondary}>
            Close
          </button>
          {onReload && (
            <button type="button" onClick={onReload} className={primary}>
              Reload App
            </button>
          )}
        </>
      ) : (
        <>
          <button type="button" onClick={onCancel} className={secondary} disabled={busy === 'import'}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onDryRun || undefined}
            disabled={disabled || busy !== null || !onDryRun}
            title={dryRunTitle}
            className={`${secondary} flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {busy === 'dry-run' ? 'Running dry run...' : 'Dry Run'}
          </button>
          <button
            type="button"
            onClick={onImport}
            disabled={disabled || busy !== null}
            className={`${primary} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {busy === 'import' ? importingLabel : importLabel}
          </button>
        </>
      )}
    </div>
  );
}
