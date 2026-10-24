import { useState } from 'react';
import { Bookmark, Trash2, X, Clock, Check } from 'lucide-react';
import { getSavedQueries, deleteQuery } from '../utils/savedQueries';
import ConfirmationModal from './common/modals/ConfirmationModal';
import { useConfirmation } from '../hooks/useConfirmation';

export default function SavedQueriesSidebar({ isOpen, onClose, onLoad }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [queries, setQueries] = useState(getSavedQueries());
  const [selectedId, setSelectedId] = useState(null);

  function handleLoad(query) {
    setSelectedId(query.id);
    onLoad(query);
    setTimeout(() => setSelectedId(null), 1000);
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
    if (await confirm({
      title: 'Delete Saved Query',
      message: 'Are you sure you want to delete this saved query?',
      type: 'danger',
      confirmLabel: 'Delete',
    })) {
      deleteQuery(id);
      setQueries(getSavedQueries());
    }
  }

  function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    // Less than 1 hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return minutes === 0 ? 'Just now' : `${minutes}m ago`;
    }

    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours}h ago`;
    }

    // Less than 7 days
    if (diff < 604800000) {
      const days = Math.floor(diff / 86400000);
      return `${days}d ago`;
    }

    // Format as date
    return date.toLocaleDateString();
  }

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 lg:hidden"
        onClick={onClose}
      />

      {/* Sidebar */}
      <div className="fixed top-0 right-0 h-full w-80 bg-os-card shadow-2xl z-50 flex flex-col font-text">
        {/* Header */}
        <div className="p-4 border-b border-os-border flex items-center justify-between bg-os-card">
          <div className="flex items-center gap-2">
            <Bookmark className="text-red-600" size={20} />
            <h2 className="text-lg font-semibold text-os-text-primary">Saved Queries</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-os-card-secondary transition-colors"
            title="Close"
          >
            <X size={20} className="text-os-text-secondary" />
          </button>
        </div>

        {/* Query List */}
        <div className="flex-1 overflow-y-auto">
          {queries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <Bookmark size={48} className="text-os-text-muted mb-3" />
              <h3 className="text-lg font-semibold text-os-text-primary mb-2">
                No saved queries yet
              </h3>
              <p className="text-sm text-os-text-secondary">
                Build a query and click "Save Query" to save it for later use.
              </p>
            </div>
          ) : (
            <div className="py-1">
              {queries.map(query => (
                <div
                  key={query.id}
                  onClick={() => handleLoad(query)}
                  className={`group relative px-4 py-3 cursor-pointer transition-colors border-l-4 ${selectedId === query.id ? 'bg-os-blue/10 border-os-blue' : 'border-transparent hover:bg-os-card-secondary'}`}
                >
                  {selectedId === query.id && (
                    <div className="absolute top-2 right-2">
                      <Check size={16} className="text-green-600" />
                    </div>
                  )}

                  <div className="flex items-start justify-between mb-2">
                    <h3 className="text-sm text-os-text-primary pr-6 truncate">
                      {query.name}
                    </h3>
                  </div>

                  <div className="mb-2">
                    <code className="block text-xs text-os-text-secondary font-mono truncate">
                      {query.jql || 'Empty query'}
                    </code>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1 text-xs text-os-text-secondary">
                      <Clock size={12} />
                      {formatDate(query.createdAt)}
                    </div>

                    <button
                      onClick={(e) => handleDelete(query.id, e)}
                      className="btn btn-danger-ghost opacity-0 group-hover:opacity-100 p-1"
                      title="Delete"
                    >
                      <Trash2 size={14} className="text-red-600" />
                    </button>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="text-xs px-2 py-0.5 bg-red-100 text-red-600 font-medium">
                      {query.state.rules.length} rule{query.state.rules.length !== 1 ? 's' : ''}
                    </span>
                    <span className="text-xs px-2 py-0.5 bg-os-card-secondary text-os-text-primary font-medium">
                      {query.state.logic}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {queries.length > 0 && (
          <div className="p-4 border-t border-os-border bg-os-card">
            <p className="text-xs text-os-text-secondary text-center font-medium">
              {queries.length} saved {queries.length === 1 ? 'query' : 'queries'}
            </p>
          </div>
        )}
      </div>

      {/* Confirmation Modal (replaces native confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </>
  );
}
