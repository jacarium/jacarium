import { useState, useEffect, useMemo, useCallback } from 'react';
import { Shield, Search, Pencil, Trash2, X, Terminal } from 'lucide-react';
import { useNotifications } from '../../../../contexts/NotificationContext';
import ConfirmationModal from '../../../common/ConfirmationModal';
import { ExternalLink } from '../../../ui/primitives';
import {
  getGtfobinsFunctions,
  getGtfobinsContexts,
  getGtfobinsExecutables,
  createGtfobinsFunction,
  updateGtfobinsFunction,
  deleteGtfobinsFunction,
  createGtfobinsExecutable,
  updateGtfobinsExecutable,
  deleteGtfobinsExecutable,
} from '../../../../utils/gtfobins';
import ExecutableDetail from './ExecutableDetail';
import ExecutableEditModal from './ExecutableEditModal';
import FunctionEditModal from './FunctionEditModal';

// True if the executable has at least one code entry (in any function) whose
// contexts object includes the given context key.
function executableUsesContext(exe, contextId) {
  for (const entries of Object.values(exe.functions || {})) {
    for (const entry of entries) {
      if (entry.contexts && contextId in entry.contexts) return true;
    }
  }
  return false;
}

// Case-insensitive search across an executable's name/description/alias AND
// every entry's code payload and per-entry comment (where most searchable
// content lives). `q` is expected to already be lowercased.
function executableMatchesSearch(exe, q) {
  if (exe.name.toLowerCase().includes(q)) return true;
  if (exe.comment && exe.comment.toLowerCase().includes(q)) return true;
  if (exe.alias && exe.alias.toLowerCase().includes(q)) return true;
  for (const entries of Object.values(exe.functions || {})) {
    for (const entry of entries) {
      if (entry.code && entry.code.toLowerCase().includes(q)) return true;
      if (entry.comment && entry.comment.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

/**
 * GTFOBins tool — a user-editable internal reference of Unix binaries that can
 * be abused to bypass local security restrictions. Pick a function (capability)
 * to filter the executables that support it, open an executable to see its code
 * snippets with copy-to-clipboard, and add/edit/delete both executables and
 * custom functions. All data persists in IndexedDB (Dexie).
 */
export default function GtfobinsTool() {
  const { addNotification } = useNotifications();

  const [loading, setLoading] = useState(true);
  const [functions, setFunctions] = useState([]);
  const [contexts, setContexts] = useState([]);
  const [executables, setExecutables] = useState([]);

  const [selectedFunction, setSelectedFunction] = useState(null); // funcId filter
  const [selectedContext, setSelectedContext] = useState(null); // contextId filter
  const [selectedExecutable, setSelectedExecutable] = useState(null); // detail view
  const [search, setSearch] = useState('');

  const [exeSort, setExeSort] = useState({ key: 'name', dir: 'asc' });

  // Modals
  const [editingExecutable, setEditingExecutable] = useState(undefined); // undefined=closed, null=new
  const [editingFunction, setEditingFunction] = useState(undefined);
  const [deleteTarget, setDeleteTarget] = useState(null); // { type, item }

  const loadAll = useCallback(async () => {
    const [fns, ctxs, exes] = await Promise.all([
      getGtfobinsFunctions(),
      getGtfobinsContexts(),
      getGtfobinsExecutables(),
    ]);
    setFunctions(fns);
    setContexts(ctxs);
    setExecutables(exes);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadAll();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  // Keep the open detail view in sync after edits.
  const refreshSelectedExecutable = useCallback(async (id) => {
    const fresh = await getGtfobinsExecutables();
    const found = fresh.find((e) => e.id === id);
    if (found) setSelectedExecutable(found);
  }, []);

  // Pills render in the dataset's natural declaration order (sortOrder asc),
  // matching the real GTFOBins site's ordering (Shell, Command, Reverse shell, ...).
  const sortedFunctions = useMemo(() => {
    const list = [...functions];
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.label.localeCompare(b.label));
    return list;
  }, [functions]);

  // Same natural-order treatment as functions (Unprivileged, Sudo, SUID, Capabilities).
  const sortedContexts = useMemo(() => {
    const list = [...contexts];
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.label.localeCompare(b.label));
    return list;
  }, [contexts]);

  const filteredExecutables = useMemo(() => {
    let list = executables;
    if (selectedFunction) {
      list = list.filter((e) => (e.functionIds || []).includes(selectedFunction));
    }
    if (selectedContext) {
      list = list.filter((e) => executableUsesContext(e, selectedContext));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((e) => executableMatchesSearch(e, q));
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name);
      return exeSort.dir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [executables, selectedFunction, selectedContext, search, exeSort]);

  const toggleExeSort = (key) =>
    setExeSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  // ---- Handlers -------------------------------------------------------------

  const handleSaveExecutable = async (data) => {
    if (editingExecutable) {
      await updateGtfobinsExecutable(editingExecutable.id, data);
      addNotification({ type: 'success', title: 'Saved', message: `"${data.name}" updated` });
      await loadAll();
      await refreshSelectedExecutable(editingExecutable.id);
    } else {
      const id = await createGtfobinsExecutable(data);
      addNotification({ type: 'success', title: 'Created', message: `"${data.name}" added` });
      await loadAll();
      const fresh = await getGtfobinsExecutables();
      const created = fresh.find((e) => e.id === id);
      if (created) setSelectedExecutable(created);
    }
    setEditingExecutable(undefined);
  };

  const handleSaveFunction = async (data) => {
    if (editingFunction) {
      await updateGtfobinsFunction(editingFunction.id, data);
      addNotification({ type: 'success', title: 'Saved', message: `Function updated` });
    } else {
      await createGtfobinsFunction(data);
      addNotification({ type: 'success', title: 'Created', message: `Function "${data.label}" added` });
    }
    await loadAll();
    setEditingFunction(undefined);
  };

  // Used by the executable modal to create + return a new funcId inline.
  const handleCreateFunctionInline = async (data) => {
    await createGtfobinsFunction(data);
    await loadAll();
    const fns = await getGtfobinsFunctions();
    const created = fns.find((f) => f.label === data.label);
    return created?.funcId;
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'executable') {
        await deleteGtfobinsExecutable(deleteTarget.item.id);
        if (selectedExecutable?.id === deleteTarget.item.id) setSelectedExecutable(null);
        addNotification({ type: 'success', title: 'Deleted', message: `"${deleteTarget.item.name}" removed` });
      } else {
        await deleteGtfobinsFunction(deleteTarget.item.id);
        if (selectedFunction === deleteTarget.item.funcId) setSelectedFunction(null);
        addNotification({ type: 'success', title: 'Deleted', message: `Function removed` });
      }
      await loadAll();
    } catch (err) {
      addNotification({ type: 'error', title: 'Error', message: err.message || 'Delete failed' });
    } finally {
      setDeleteTarget(null);
    }
  };

  // ---- Render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-os-background">
        <p className="text-sm text-os-text-secondary">Loading GTFOBins data…</p>
      </div>
    );
  }

  // Detail view takes over the whole pane.
  if (selectedExecutable) {
    return (
      <div className="h-full bg-os-background">
        <ExecutableDetail
          executable={selectedExecutable}
          functions={functions}
          contexts={contexts}
          onBack={() => setSelectedExecutable(null)}
          onEdit={(exe) => setEditingExecutable(exe)}
          onDelete={(exe) => setDeleteTarget({ type: 'executable', item: exe })}
        />
        {editingExecutable !== undefined && (
          <ExecutableEditModal
            executable={editingExecutable}
            functions={functions}
            contexts={contexts}
            onSave={handleSaveExecutable}
            onClose={() => setEditingExecutable(undefined)}
            onCreateFunction={handleCreateFunctionInline}
          />
        )}
        <ConfirmationModal
          isOpen={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
          title={deleteTarget?.type === 'executable' ? 'Delete Executable' : 'Delete Function'}
          message={
            deleteTarget?.type === 'executable'
              ? `Delete "${deleteTarget?.item?.name}"? This cannot be undone.`
              : `Delete function "${deleteTarget?.item?.label}"? It will be detached from all executables. This cannot be undone.`
          }
          confirmText="Delete"
          dangerous
        />
      </div>
    );
  }

  const selectedFunctionMeta = functions.find((f) => f.funcId === selectedFunction);
  const selectedContextMeta = contexts.find((c) => c.contextId === selectedContext);

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-auto">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Shield size={20} className="text-os-text-primary" />
            <h3 className="text-lg font-semibold text-os-text-primary">GTFOBins</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditingFunction(null)}
              className="px-3 py-1.5 flex items-center gap-2 border border-os-border rounded-sm hover:bg-os-card-secondary text-os-text-primary text-sm transition-colors"
            >
               Function
            </button>
            <button
              onClick={() => setEditingExecutable(null)}
              className="btn btn-primary px-3 py-1.5 flex items-center gap-2 text-sm"
            >
               Executable
            </button>
          </div>
        </div>

        {/* Functions (click a pill to filter executables; hover for details) */}
        <section>
          <h4 className="text-sm font-semibold text-os-text-primary uppercase tracking-wide mb-2">
            Functions
          </h4>
          <div className="border border-os-border rounded-sm p-3">
            <div className="flex flex-wrap gap-2">
              {sortedFunctions.map((fn) => {
                const active = selectedFunction === fn.funcId;
                const tooltip = `${fn.description}${fn.isBuiltIn ? '' : ' (custom)'}`;
                return (
                  <div
                    key={fn.funcId}
                    className={`flex items-center gap-2 pl-3 pr-2 py-1.5 rounded border text-sm transition-colors ${
 active
 ?'bg-blue-50 dark:bg-blue-900/20 border-os-blue text-os-blue font-medium'
 :'bg-os-card border-os-border text-os-text-secondary hover:bg-os-card-secondary'
 }`}
                  >
                    <button
                      onClick={() => setSelectedFunction(active ? null : fn.funcId)}
                      title={tooltip}
                      className="cursor-pointer"
                    >
                      {fn.label}
                    </button>
                    {/* Always-visible Edit/Delete; they must not toggle selection */}
                    <span className="flex items-center gap-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingFunction(fn);
                        }}
                        title="Edit function"
                        className="p-0.5 rounded-sm text-os-text-muted hover:text-os-text-primary transition-colors"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget({ type: 'function', item: fn });
                        }}
                        title="Delete function"
                        className="p-0.5 rounded-sm text-os-text-muted hover:text-red-600 transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Contexts (read-only reference; click a pill to filter/highlight) */}
        <section>
          <h4 className="text-sm font-semibold text-os-text-primary uppercase tracking-wide mb-2">
            Contexts
          </h4>
          <div className="border border-os-border rounded-sm p-3">
            <div className="flex flex-wrap gap-2">
              {sortedContexts.map((ctx) => {
                const active = selectedContext === ctx.contextId;
                const tooltip = ctx.description;
                return (
                  <button
                    key={ctx.contextId}
                    onClick={() => setSelectedContext(active ? null : ctx.contextId)}
                    title={tooltip}
                    className={`px-3 py-1.5 border text-sm transition-colors ${
 active
 ?'btn-selected-soft'
 :'bg-os-card border-os-border text-os-text-secondary hover:bg-os-card-secondary'
 }`}
                  >
                    {ctx.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Executables table */}
        <section>
          {/* Full-width search row */}
          <div className="relative mb-3">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-os-text-secondary" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, code, comments…"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-os-border rounded-sm bg-os-card text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <h4 className="text-sm font-semibold text-os-text-primary uppercase tracking-wide flex items-center gap-2">
              Executables
              <span className="text-os-text-muted font-normal normal-case">
                ({filteredExecutables.length})
              </span>
            </h4>
            <div className="flex items-center gap-2">
              {selectedFunctionMeta && (
                <button
                  onClick={() => setSelectedFunction(null)}
                  className="btn btn-selected-soft flex items-center gap-1 px-2 py-1 text-xs"
                >
                  {selectedFunctionMeta.label}
                  <X size={12} />
                </button>
              )}
              {selectedContextMeta && (
                <button
                  onClick={() => setSelectedContext(null)}
                  className="btn btn-selected-soft flex items-center gap-1 px-2 py-1 text-xs"
                >
                  {selectedContextMeta.label}
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          <div className="border border-os-border rounded-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-os-card-secondary">
                <tr>
                  <th className="text-left px-3 py-2">
                    <button
                      onClick={() => toggleExeSort('name')}
                      className="flex items-center gap-1 text-os-text-secondary hover:text-os-text-primary"
                    >
                      Name 
                    </button>
                  </th>
                  <th className="text-left px-3 py-2 hidden md:table-cell font-semibold text-os-text-secondary">
                    Functions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredExecutables.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-3 py-8 text-center text-os-text-muted">
                      {executables.length === 0
                        ? 'No executables yet: add one above, or import a database export that holds them.'
                        : 'No executables match.'}
                    </td>
                  </tr>
                ) : (
                  filteredExecutables.map((exe) => (
                    <tr
                      key={exe.id}
                      onClick={() => setSelectedExecutable(exe)}
                      className="cursor-pointer border-t border-os-border hover:bg-os-card-secondary transition-colors"
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Terminal size={13} className="text-os-text-muted shrink-0" />
                          <span className="font-mono font-medium text-os-text-primary">{exe.name}</span>
                          {exe.alias && (
                            <span className="text-xs text-os-text-muted">→ {exe.alias}</span>
                          )}
                          {!exe.isBuiltIn && <span className="text-xs text-os-blue">custom</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 hidden md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {(exe.functionIds || []).map((fid) => {
                            const meta = functions.find((f) => f.funcId === fid);
                            // Highlight when this function is the selected one,
                            // or when a context is selected and THIS executable's
                            // entries for this function include that context.
                            const matched =
                              selectedFunction === fid ||
                              (selectedContext &&
                                (exe.functions?.[fid] || []).some(
                                  (entry) => entry.contexts && selectedContext in entry.contexts
                                ));
                            // For the inherit function, append the distinct
                            // target(s) it delegates to, e.g. "Inherit: less, irb".
                            const baseLabel = meta ? meta.label : fid;
                            let label = baseLabel;
                            if (fid === 'inherit') {
                              const froms = [
                                ...new Set(
                                  (exe.functions?.inherit || []).map((e) => e.from).filter(Boolean)
                                ),
                              ];
                              if (froms.length) label = `${baseLabel}: ${froms.join(', ')}`;
                            }
                            return (
                              <span
                                key={fid}
                                className={`px-1.5 py-0.5 rounded text-xs border ${
 matched
 ?'bg-blue-50 dark:bg-blue-900/20 border-os-blue text-os-blue font-medium'
 :'bg-os-card border-os-border text-os-text-secondary'
 }`}
                              >
                                {label}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Credit: the tool is modelled on GTFOBins and holds entries in its
            format; the app ships none of its data (users add entries or
            import them), so this is attribution, not a licence notice. */}
        <p className="text-xs text-os-text-muted">
          Reference data in the format of{' '}
          <ExternalLink href="https://gtfobins.org" className="text-xs">GTFOBins</ExternalLink>,
          the curated list of Unix binaries that can be used to bypass local
          security restrictions. Jacarium ships none of its data: add entries
          by hand, or import a database export that holds them.
        </p>
      </div>

      {/* Modals */}
      {editingExecutable !== undefined && (
        <ExecutableEditModal
          executable={editingExecutable}
          functions={functions}
          contexts={contexts}
          onSave={handleSaveExecutable}
          onClose={() => setEditingExecutable(undefined)}
          onCreateFunction={handleCreateFunctionInline}
        />
      )}
      {editingFunction !== undefined && (
        <FunctionEditModal
          func={editingFunction}
          onSave={handleSaveFunction}
          onClose={() => setEditingFunction(undefined)}
        />
      )}
      <ConfirmationModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title={deleteTarget?.type === 'executable' ? 'Delete Executable' : 'Delete Function'}
        message={
          deleteTarget?.type === 'executable'
            ? `Delete "${deleteTarget?.item?.name}"? This cannot be undone.`
            : `Delete function "${deleteTarget?.item?.label}"? It will be detached from all executables. This cannot be undone.`
        }
        confirmText="Delete"
        dangerous
      />
    </div>
  );
}
