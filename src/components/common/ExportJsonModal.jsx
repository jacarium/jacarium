import { useEffect, useRef, useState } from 'react';
import { FileJson } from 'lucide-react';
import BaseModal from './modals/BaseModal';
import { Button, ButtonRow, TextArea } from '../ui/primitives';
import { copyToClipboard } from '../../utils/markdownToJira';
import { downloadBlob } from '../../utils/exportHelpers';

/**
 * ExportJsonModal - the counterpart of ImportJsonModal: the exported JSON
 * in a read-only monospace box, selected as the dialog opens, with Copy
 * (the app's clipboard helper, "Copied" for a moment) and Download, so the
 * text travels by Ctrl/Cmd+C into another app's Import JSON dialog as
 * well as by file. Ctrl/Cmd+A and +C inside the box are the textarea's
 * own (no chord handler here: the shortcut registry's dispatcher leaves
 * a focused text field alone, src/shortcuts/useShortcut.js).
 * Settings > Theme exports a theme with it; other exports can use it the
 * same way: `text` is what is shown and copied, `filename` what Download
 * writes (`mimeType` application/json).
 */
export default function ExportJsonModal({
  isOpen,
  onClose,
  text = '',
  filename = 'export.json',
  mimeType = 'application/json',
  title = 'Export JSON',
  description = 'Copy the JSON below or download it as a file.',
  copyLabel = 'Copy',
  downloadLabel = 'Download',
  rows = 14,
  testId = 'export-json-modal',
}) {
  const boxRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // the text selected as the dialog opens (and again on a click into the box): Ctrl/Cmd+C copies it as it is
  useEffect(() => {
    if (!isOpen) return undefined;
    const id = setTimeout(() => { boxRef.current?.focus(); boxRef.current?.select(); }, 30);
    return () => clearTimeout(id);
  }, [isOpen, text]);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    const ok = await copyToClipboard(text);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) { boxRef.current?.focus(); boxRef.current?.select(); }
  };
  const download = () => downloadBlob(new Blob([text], { type: mimeType }), filename);
  const close = () => { setCopied(false); setCopyFailed(false); onClose(); };

  return (
    <BaseModal isOpen={isOpen} onClose={close} className="max-w-3xl w-full rounded-lg">
      <div className="p-6 max-h-[80vh] overflow-y-auto" data-testid={testId}>
        <div className="flex items-start gap-4 mb-4">
          <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/30 shrink-0">
            <FileJson size={24} className="text-blue-600 dark:text-blue-300" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-os-text-primary mb-1">{title}</h3>
            <p className="text-sm text-os-text-secondary">{description}</p>
          </div>
        </div>
        <TextArea
          ref={boxRef}
          value={text}
          readOnly
          rows={rows}
          spellCheck={false}
          wrap="off"
          aria-label={title}
          onFocus={(e) => e.target.select()}
          className="resize-y whitespace-pre"
          data-testid="export-json-text"
        />
        <p className="text-xs text-os-text-muted mt-1">{filename}</p>
        <ButtonRow className="mt-4">
          <Button onClick={close} data-testid="export-json-close">Close</Button>
          <Button onClick={download} data-testid="export-json-download">{downloadLabel}</Button>
          <Button variant="primary" onClick={copy} data-testid="export-json-copy" aria-live="polite">{copied ? 'Copied' : (copyFailed ? 'Copy failed - select and press Ctrl/Cmd+C' : copyLabel)}</Button>
        </ButtonRow>
      </div>
    </BaseModal>
  );
}
