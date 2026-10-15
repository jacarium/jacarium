/**
 * Small helpers shared by the export paths (exportDatabase.js and
 * useImportExport.js).
 */

/**
 * Human-readable byte count for export logs ("1.4 MB").
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Trigger a browser download of a Blob via a temporary anchor.
 * @param {Blob} blob
 * @param {string} filename - Filename with extension
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Today's date as the YYYY-MM-DD suffix every export filename carries.
 * @returns {string}
 */
export function dateStamp() {
  return new Date().toISOString().split('T')[0];
}
