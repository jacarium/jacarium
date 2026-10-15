import { useState, useMemo } from 'react';
import { Copy, Check } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Render a single GTFOBins function entry: optional comment, context badges,
 * version/from metadata, and the code payload with a copy-to-clipboard button.
 */
export default function CodeBlock({ entry, contexts = [] }) {
  const [copied, setCopied] = useState(false);
  const [suidCopied, setSuidCopied] = useState(false);

  // Context labels come from the single source of truth (the gtfobinsContexts
  // dataset) so badges match the Contexts pills exactly. Falls back to the raw
  // key if a context is unknown (e.g. contexts not yet loaded).
  const contextsById = Object.fromEntries(contexts.map((c) => [c.contextId, c]));

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(entry.code || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCopySuid = async () => {
    try {
      await navigator.clipboard.writeText(suidOverrideCode || '');
      setSuidCopied(true);
      setTimeout(() => setSuidCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const contextKeys = entry.contexts ? Object.keys(entry.contexts) : [];

  // The per-entry caveat is user-editable, persisted, and flows through
  // import/export, so its Markdown MUST be sanitized before injection to avoid
  // stored XSS (DOMPurify is non-negotiable here, not optional hardening).
  const commentHtml = useMemo(
    () => DOMPurify.sanitize(marked(entry.comment || '')),
    [entry.comment]
  );

  const hasTags = contextKeys.length > 0 || entry.version || entry.from || entry.binary === false;

  // SUID contexts can carry a code override that differs from the entry's main
  // code (~18% of executables). Only show a separate block when it actually
  // differs — no point duplicating an identical payload.
  const suidOverrideCode = entry.contexts?.suid?.code;
  const showSuidOverride = suidOverrideCode && suidOverrideCode !== entry.code;

  return (
    <div className="rounded-sm border border-os-border bg-os-card">
      {(entry.comment || hasTags || entry.code) && (
        <div className="px-3 py-2 border-b border-os-border space-y-2">
          {entry.comment && (
            <div
              className="text-sm text-os-text-secondary prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: commentHtml }}
            />
          )}
          {(hasTags || entry.code) && (
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {contextKeys.map((key) => {
                  const detail = entry.contexts[key];
                  const extra =
                    detail && typeof detail === 'object'
                      ? Object.entries(detail)
                          .filter(([k]) => k !== 'code')
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(', ')
                      : '';
                  return (
                    <span
                      key={key}
                      title={extra || undefined}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium bg-os-card-secondary border border-os-border text-os-text-secondary"
                    >
                      {contextsById[key]?.label || key}
                      {extra && <span className="text-os-text-muted">({extra})</span>}
                    </span>
                  );
                })}
                {entry.version && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-os-blue border border-os-border">
                    version: {entry.version}
                  </span>
                )}
                {entry.from && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-os-blue border border-os-border">
                    inherits from: {entry.from}
                  </span>
                )}
                {entry.binary === false && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-os-border">
                    not raw binary
                  </span>
                )}
              </div>
              {entry.code && (
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors shrink-0"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <>
                      <Check size={12} className="text-green-600" />
                      Copied!
                    </>
                  ) : (
                    <>
                      Copy
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {entry.code ? (
        <pre className="p-3 overflow-x-auto text-sm font-mono text-os-text-primary whitespace-pre">
          {entry.code}
        </pre>
      ) : (
        <p className="p-3 text-sm text-os-text-muted italic">No code payload for this entry.</p>
      )}

      {showSuidOverride && (
        <div className="border-t border-os-border">
          <div className="flex items-center justify-between px-3 pt-2">
            <span className="text-xs font-semibold text-os-text-muted uppercase tracking-wide">
              SUID override
            </span>
            <button
              onClick={handleCopySuid}
              className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
              title="Copy to clipboard"
            >
              {suidCopied ? (
                <>
                  <Check size={12} className="text-green-600" />
                  Copied!
                </>
              ) : (
                <>
                  Copy
                </>
              )}
            </button>
          </div>
          <pre className="p-3 overflow-x-auto text-sm font-mono text-os-text-primary whitespace-pre">
            {suidOverrideCode}
          </pre>
        </div>
      )}
    </div>
  );
}
