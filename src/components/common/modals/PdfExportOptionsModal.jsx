import { useState } from 'react';
import { FileDown, X } from 'lucide-react';
import BaseModal from './BaseModal';
import { PDF_PAGE_SIZES, loadPdfOptions, savePdfOptions, normalizePdfOptions } from '../../../utils/pdfExportNative';

/**
 * PdfExportOptionsModal - the small options step before a document is
 * exported as PDF: page size (A4 / US Letter / US Legal) and orientation.
 * The last choice is remembered per browser profile (localStorage) and
 * offered again next time; the defaults are A4 portrait.
 *
 * Mount it only while it is needed (DocumentSidebar renders it when a
 * document is waiting to be exported): the remembered choice is read when
 * the component mounts.
 *
 * `onExport({ pageSize, landscape })` starts the export (the caller feeds
 * the options into useImportExport's exportDocumentToPDF); `onClose`
 * cancels.
 */
export default function PdfExportOptionsModal({ isOpen, onClose, onExport, documentTitle = '' }) {
  const [options, setOptions] = useState(() => loadPdfOptions());

  const handleExport = () => {
    const chosen = normalizePdfOptions(options);
    savePdfOptions(chosen);
    onExport(chosen);
  };

  const selectClass = 'w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-input-bg text-os-text-primary';

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} className="max-w-md w-full">
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileDown size={18} className="text-os-text-secondary" />
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">Export PDF</h2>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-os-sidebar-hover transition-colors" title="Close">
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>
      <div className="p-6 space-y-4 bg-os-modal">
        {documentTitle && (
          <p className="text-sm text-os-text-secondary truncate" title={documentTitle}>{documentTitle}</p>
        )}
        <div>
          <label htmlFor="pdf-export-page-size" className="block text-xs text-os-text-secondary mb-1">Page size</label>
          <select
            id="pdf-export-page-size"
            name="pageSize"
            className={selectClass}
            value={options.pageSize}
            onChange={(e) => setOptions((o) => ({ ...o, pageSize: e.target.value }))}
          >
            {Object.entries(PDF_PAGE_SIZES).map(([key, size]) => (
              <option key={key} value={key}>{size.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pdf-export-orientation" className="block text-xs text-os-text-secondary mb-1">Orientation</label>
          <select
            id="pdf-export-orientation"
            name="orientation"
            className={selectClass}
            value={options.landscape ? 'landscape' : 'portrait'}
            onChange={(e) => setOptions((o) => ({ ...o, landscape: e.target.value === 'landscape' }))}
          >
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </div>
      </div>
      <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors rounded-sm"
        >
          Cancel
        </button>
        <button
          onClick={handleExport}
          className="btn btn-primary px-4 py-2 text-sm"
        >
          Export
        </button>
      </div>
    </BaseModal>
  );
}
