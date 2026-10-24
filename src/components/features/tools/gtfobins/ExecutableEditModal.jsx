import { useState } from 'react';
import { X, Trash2, ChevronDown, ChevronRight } from 'lucide-react';

// The fixed set of valid context keys for the checkboxes, in the UI's display
// order. This is intentionally hardcoded (not derived from the gtfobinsContexts
// dataset) so the checkboxes always render even if contexts haven't loaded;
// display labels, however, come from that dataset (see contextsById below).
const CONTEXT_KEYS = ['sudo', 'suid', 'unprivileged', 'capabilities'];

// Convert a stored function entry into an editable one (contexts as booleans,
// with the original context detail preserved so nested info survives a save
// that doesn't touch it).
function toEditableEntry(entry) {
  const contexts = {};
  for (const key of CONTEXT_KEYS) {
    contexts[key] = Boolean(entry.contexts && key in entry.contexts);
  }
  return {
    code: entry.code || '',
    comment: entry.comment || '',
    version: entry.version || '',
    from: entry.from || '',
    binary: entry.binary,
    contexts,
    // Editable structured sub-fields for the contexts that carry them.
    suidShell: Boolean(entry.contexts?.suid?.shell),
    suidCodeOverride: entry.contexts?.suid?.code || '',
    capabilitiesList: (entry.contexts?.capabilities?.list || []).join(', '),
    origContexts: entry.contexts || {},
  };
}

function emptyEditableEntry() {
  return {
    code: '',
    comment: '',
    version: '',
    from: '',
    contexts: { sudo: true, suid: true, unprivileged: true, capabilities: false },
    suidShell: false,
    suidCodeOverride: '',
    capabilitiesList: '',
    origContexts: {},
  };
}

// Convert an editable entry back into the stored shape.
function toStoredEntry(editable) {
  const out = {};
  if (editable.code) out.code = editable.code;
  if (editable.comment && editable.comment.trim()) out.comment = editable.comment.trim();
  if (editable.version && editable.version.trim()) out.version = editable.version.trim();
  if (editable.from && editable.from.trim()) out.from = editable.from.trim();
  if (editable.binary === false) out.binary = false;
  const contexts = {};
  let hasContext = false;
  for (const key of CONTEXT_KEYS) {
    if (!editable.contexts[key]) continue;
    hasContext = true;

    if (key === 'suid') {
      // Merge the edited shell boolean and the editable SUID-specific code
      // override while preserving any other detail (e.g. rare comment override)
      // already on the object. The code override is a real editable field:
      // clearing it in the UI removes a previously-existing override.
      const suidCtx = { ...(editable.origContexts.suid || {}), shell: editable.suidShell };
      const codeOverride = editable.suidCodeOverride && editable.suidCodeOverride.trim();
      if (codeOverride) {
        suidCtx.code = codeOverride;
      } else {
        delete suidCtx.code;
      }
      contexts.suid = suidCtx;
    } else if (key === 'capabilities') {
      const list = editable.capabilitiesList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const base = { ...(editable.origContexts.capabilities || {}) };
      if (list.length > 0) {
        base.list = list;
      } else {
        // Empty -> unset: don't persist an empty array.
        delete base.list;
      }
      contexts.capabilities = Object.keys(base).length > 0 ? base : null;
    } else {
      // sudo / unprivileged: preserve whatever was there, or null.
      contexts[key] = editable.origContexts[key] ?? null;
    }
  }
  if (hasContext) out.contexts = contexts;
  return out;
}

/**
 * Create/edit an executable: name, description, alias, and the set of functions
 * it supports — each function having one or more code entries with their own
 * comment/version/contexts.
 */
export default function ExecutableEditModal({
  executable,
  functions,
  contexts = [],
  onSave,
  onClose,
  onCreateFunction,
}) {
  const isNew = !executable;
  // Context display labels sourced from the gtfobinsContexts dataset (single
  // source of truth), falling back to the raw key if unknown/not loaded.
  const contextsById = Object.fromEntries(contexts.map((c) => [c.contextId, c]));
  const [name, setName] = useState(executable?.name || '');
  const [comment, setComment] = useState(executable?.comment || '');
  const [alias, setAlias] = useState(executable?.alias || '');
  const [error, setError] = useState('');

  // attachments: [{ funcId, entries: [editableEntry], expanded }]
  const [attachments, setAttachments] = useState(() => {
    if (!executable) return [];
    return (executable.functionIds || []).map((funcId) => ({
      funcId,
      entries: (executable.functions[funcId] || []).map(toEditableEntry),
      expanded: true,
    }));
  });

  const [attachFuncId, setAttachFuncId] = useState('');
  const [showNewFunc, setShowNewFunc] = useState(false);
  const [newFuncLabel, setNewFuncLabel] = useState('');
  const [newFuncDesc, setNewFuncDesc] = useState('');

  const functionsById = Object.fromEntries(functions.map((f) => [f.funcId, f]));
  const attachedIds = new Set(attachments.map((a) => a.funcId));
  const availableFunctions = functions.filter((f) => !attachedIds.has(f.funcId));

  const updateAttachment = (index, patch) => {
    setAttachments((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };

  const updateEntry = (attachIndex, entryIndex, patch) => {
    setAttachments((prev) =>
      prev.map((a, i) => {
        if (i !== attachIndex) return a;
        return {
          ...a,
          entries: a.entries.map((e, j) => (j === entryIndex ? { ...e, ...patch } : e)),
        };
      })
    );
  };

  const addAttachment = () => {
    if (!attachFuncId) return;
    setAttachments((prev) => [
      ...prev,
      { funcId: attachFuncId, entries: [emptyEditableEntry()], expanded: true },
    ]);
    setAttachFuncId('');
  };

  const removeAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const addEntry = (attachIndex) => {
    setAttachments((prev) =>
      prev.map((a, i) =>
        i === attachIndex ? { ...a, entries: [...a.entries, emptyEditableEntry()] } : a
      )
    );
  };

  const removeEntry = (attachIndex, entryIndex) => {
    setAttachments((prev) =>
      prev.map((a, i) =>
        i === attachIndex ? { ...a, entries: a.entries.filter((_, j) => j !== entryIndex) } : a
      )
    );
  };

  const handleCreateFunction = async () => {
    const label = newFuncLabel.trim();
    if (!label) return;
    try {
      const funcId = await onCreateFunction({ label, description: newFuncDesc.trim() });
      setAttachments((prev) => [
        ...prev,
        { funcId, entries: [emptyEditableEntry()], expanded: true },
      ]);
      setNewFuncLabel('');
      setNewFuncDesc('');
      setShowNewFunc(false);
    } catch (err) {
      setError(err.message || 'Failed to create function');
    }
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Executable name is required');
      return;
    }
    const functionsObj = {};
    for (const attach of attachments) {
      const entries = attach.entries.map(toStoredEntry);
      functionsObj[attach.funcId] = entries;
    }
    try {
      await onSave({
        name: trimmed,
        comment: comment.trim(),
        alias: alias.trim() || null,
        functions: functionsObj,
      });
    } catch (err) {
      setError(err.message || 'Failed to save executable');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-os-modal shadow-lg max-w-3xl w-full border border-os-border rounded-sm max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-os-border flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-os-text-primary uppercase tracking-wide">
            {isNew ? 'New Executable' : `Edit ${executable.name}`}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors">
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
                Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., nmap"
                className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
                Alias of (optional)
              </label>
              <input
                type="text"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="e.g., awk"
                className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
              Description (optional)
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Overall description of the binary (Markdown supported)"
              rows="3"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
            />
          </div>

          {/* Functions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs text-os-text-primary uppercase tracking-wide">
                Functions ({attachments.length})
              </label>
            </div>

            <div className="space-y-3">
              {attachments.map((attach, attachIndex) => {
                const fn = functionsById[attach.funcId];
                return (
                  <div key={attach.funcId} className="border border-os-border rounded-sm bg-os-card">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-os-border">
                      <button
                        onClick={() => updateAttachment(attachIndex, { expanded: !attach.expanded })}
                        className="flex items-center gap-2 text-sm text-os-text-primary"
                      >
                        {attach.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {fn ? fn.label : attach.funcId}
                        <span className="text-xs text-os-text-muted">
                          ({attach.entries.length} {attach.entries.length === 1 ? 'entry' : 'entries'})
                        </span>
                      </button>
                      <button
                        onClick={() => removeAttachment(attachIndex)}
                        className="btn btn-danger-ghost p-1"
                        title="Remove function"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {attach.expanded && (
                      <div className="p-3 space-y-3">
                        {attach.entries.map((entry, entryIndex) => (
                          <div key={entryIndex} className="border border-os-border rounded-sm p-3 space-y-2 bg-os-modal">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-os-text-muted uppercase">
                                Entry {entryIndex + 1}
                              </span>
                              <button
                                onClick={() => removeEntry(attachIndex, entryIndex)}
                                className="btn btn-danger-ghost p-1"
                                title="Remove entry"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                            <textarea
                              value={entry.code}
                              onChange={(e) => updateEntry(attachIndex, entryIndex, { code: e.target.value })}
                              placeholder="Code payload"
                              rows="3"
                              className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue resize-y text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
                            />
                            <textarea
                              value={entry.comment}
                              onChange={(e) => updateEntry(attachIndex, entryIndex, { comment: e.target.value })}
                              placeholder="Comment / caveat (optional, Markdown supported)"
                              rows="2"
                              className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue resize-y text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                            />
                            <div className="grid grid-cols-2 gap-2">
                              <input
                                type="text"
                                value={entry.version}
                                onChange={(e) => updateEntry(attachIndex, entryIndex, { version: e.target.value })}
                                placeholder="Version (optional)"
                                className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                              />
                              <input
                                type="text"
                                value={entry.from}
                                onChange={(e) => updateEntry(attachIndex, entryIndex, { from: e.target.value })}
                                placeholder="Inherits from (optional)"
                                className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                              />
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              {CONTEXT_KEYS.map((key) => (
                                <label key={key} className="flex items-center gap-1.5 text-sm text-os-text-secondary cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={entry.contexts[key]}
                                    onChange={(e) =>
                                      updateEntry(attachIndex, entryIndex, {
                                        contexts: { ...entry.contexts, [key]: e.target.checked },
                                      })
                                    }
                                    className="text-os-blue focus:ring-os-blue"
                                  />
                                  {contextsById[key]?.label || key}
                                </label>
                              ))}
                            </div>
                            {/* Context-specific structured sub-fields (only when the
                                context is checked, to keep the common case clean). */}
                            {(entry.contexts.suid || entry.contexts.capabilities) && (
                              <div className="pl-4 border-l-2 border-os-border space-y-2">
                                {entry.contexts.suid && (
                                  <>
                                    <label className="flex items-center gap-1.5 text-xs text-os-text-muted cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={entry.suidShell}
                                        onChange={(e) =>
                                          updateEntry(attachIndex, entryIndex, { suidShell: e.target.checked })
                                        }
                                        className="text-os-blue focus:ring-os-blue"
                                      />
                                      SUID runs commands via shell
                                    </label>
                                    <div className="flex flex-col gap-1">
                                      <span className="text-xs text-os-text-muted">
                                        SUID-specific code override (optional)
                                      </span>
                                      <textarea
                                        value={entry.suidCodeOverride}
                                        onChange={(e) =>
                                          updateEntry(attachIndex, entryIndex, { suidCodeOverride: e.target.value })
                                        }
                                        placeholder="Leave blank unless the SUID case needs different code than the Code field above"
                                        rows="2"
                                        className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue resize-y text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
                                      />
                                    </div>
                                  </>
                                )}
                                {entry.contexts.capabilities && (
                                  <div className="flex flex-col gap-1">
                                    <span className="text-xs text-os-text-muted">Capabilities needed</span>
                                    <input
                                      type="text"
                                      value={entry.capabilitiesList}
                                      onChange={(e) =>
                                        updateEntry(attachIndex, entryIndex, { capabilitiesList: e.target.value })
                                      }
                                      placeholder="CAP_DAC_OVERRIDE, CAP_SETUID"
                                      className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted font-mono"
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                        <button
                          onClick={() => addEntry(attachIndex)}
                          className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary border border-os-border rounded-sm transition-colors"
                        >
                           Add entry
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Attach existing / new function */}
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={attachFuncId}
                  onChange={(e) => setAttachFuncId(e.target.value)}
                  className="flex-1 px-3 py-2 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-modal text-os-text-primary"
                >
                  <option value="">Attach a function…</option>
                  {availableFunctions.map((f) => (
                    <option key={f.funcId} value={f.funcId}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={addAttachment}
                  disabled={!attachFuncId}
                  className="btn btn-primary flex items-center gap-1 px-3 py-2 text-sm"
                >
                   Attach
                </button>
                <button
                  onClick={() => setShowNewFunc((v) => !v)}
                  className="px-3 py-2 border border-os-border text-os-text-primary text-sm rounded-sm hover:bg-os-card-secondary transition-colors"
                >
                  New function
                </button>
              </div>

              {showNewFunc && (
                <div className="border border-os-border rounded-sm p-3 space-y-2 bg-os-card">
                  <input
                    type="text"
                    value={newFuncLabel}
                    onChange={(e) => setNewFuncLabel(e.target.value)}
                    placeholder="Function label (e.g., Kernel module load)"
                    className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                  />
                  <input
                    type="text"
                    value={newFuncDesc}
                    onChange={(e) => setNewFuncDesc(e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full px-2 py-1.5 border border-os-input-border rounded-sm outline-hidden focus:ring-2 focus:ring-os-blue text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                  />
                  <button
                    onClick={handleCreateFunction}
                    disabled={!newFuncLabel.trim()}
                    className="btn btn-primary flex items-center gap-1 px-3 py-1.5 text-sm"
                  >
                     Create &amp; attach
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-os-border flex items-center justify-end gap-3 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-os-input-border text-os-text-primary text-sm rounded-sm hover:bg-os-card-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="btn btn-primary px-4 py-2 text-sm"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
