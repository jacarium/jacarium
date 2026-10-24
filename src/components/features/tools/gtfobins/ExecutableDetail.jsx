import { useMemo } from 'react';
import { ArrowLeft, CornerDownRight } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import CodeBlock from './CodeBlock';

/**
 * Detail view for a single executable: overall description, and per supported
 * function the description plus each code entry (with contexts + copy button),
 * mirroring what the real GTFOBins page shows for a binary.
 */
export default function ExecutableDetail({ executable, functions, contexts, onBack, onEdit, onDelete }) {
  const functionsById = Object.fromEntries(functions.map((f) => [f.funcId, f]));
  const supported = (executable.functionIds || [])
    .map((funcId) => functionsById[funcId])
    .filter(Boolean);

  // The overall description is user-editable, persisted, and flows through
  // import/export, so its Markdown MUST be sanitized before injection to avoid
  // stored XSS (DOMPurify is non-negotiable here, not optional hardening).
  const commentHtml = useMemo(
    () => DOMPurify.sanitize(marked(executable.comment || '')),
    [executable.comment]
  );

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-auto">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onBack}
              className="p-1.5 rounded-sm hover:bg-os-card-secondary transition-colors shrink-0"
              title="Back to list"
            >
              <ArrowLeft size={18} className="text-os-text-secondary" />
            </button>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-os-text-primary font-mono truncate">
                {executable.name}
              </h2>
              {executable.isBuiltIn ? null : (
                <span className="text-xs text-os-blue">custom</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onEdit(executable)}
              className="px-3 py-1.5 flex items-center gap-2 border border-os-border rounded-sm hover:bg-os-card-secondary text-os-text-primary text-sm transition-colors"
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(executable)}
              className="btn btn-danger px-3 py-1.5 flex items-center gap-2 text-sm"
            >
              Delete
            </button>
          </div>
        </div>

        {executable.comment && (
          <div
            className="text-sm text-os-text-secondary prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: commentHtml }}
          />
        )}

        {executable.alias && (
          <div className="flex items-center gap-2 text-sm text-os-text-secondary bg-os-card border border-os-border rounded-sm px-3 py-2">
            <CornerDownRight size={14} className="text-os-text-muted" />
            This is an alias of{' '}
            <span className="font-mono font-medium text-os-text-primary">{executable.alias}</span>.
          </div>
        )}

        {supported.length === 0 && !executable.alias && (
          <div className="text-sm text-os-text-muted italic">
            This executable has no functions yet. Use Edit to add capabilities.
          </div>
        )}

        {supported.map((fn) => {
          const entries = executable.functions[fn.funcId] || [];
          return (
            <section key={fn.funcId} className="space-y-2">
              <div>
                <h3 className="text-base font-semibold text-os-text-primary">{fn.label}</h3>
                {fn.description && (
                  <p className="text-sm text-os-text-secondary">{fn.description}</p>
                )}
              </div>
              <div className="space-y-3">
                {entries.map((entry, i) => (
                  <CodeBlock key={i} entry={entry} contexts={contexts} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
