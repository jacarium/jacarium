import { useState, useEffect } from 'react';
import { X, Trash2, GripVertical } from 'lucide-react';
import BaseModal from '../common/modals/BaseModal';
import ConfirmationModal from '../common/ConfirmationModal';

export default function BoardSettingsModal({ isOpen, onClose, onSave, board }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('General');
  const [columns, setColumns] = useState([]);
  const [alertDialog, setAlertDialog] = useState({
    isOpen: false,
    title: '',
    message: ''
  });

  useEffect(() => {
    if (board) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(board.title || '');
      setDescription(board.description || '');
      setCategory(board.category || 'General');
      setColumns(board.columns || []);
    } else {
      setTitle('');
      setDescription('');
      setCategory('General');
      setColumns([]);
    }
  }, [board, isOpen]);

  function handleAddColumn() {
    const newColumn = {
      id: `col-${Date.now()}`,
      title: 'New Column',
      color: '#94a3b8'
    };
    setColumns([...columns, newColumn]);
  }

  function handleUpdateColumn(index, field, value) {
    const updatedColumns = [...columns];
    updatedColumns[index] = { ...updatedColumns[index], [field]: value };
    setColumns(updatedColumns);
  }

  function handleDeleteColumn(index) {
    if (columns.length <= 1) {
      setAlertDialog({
        isOpen: true,
        title: 'Cannot Delete Column',
        message: 'You must have at least one column'
      });
      return;
    }
    setColumns(columns.filter((_, i) => i !== index));
  }

  function handleSubmit(e) {
    e.preventDefault();

    if (!title.trim()) {
      return;
    }

    if (columns.length === 0) {
      setAlertDialog({
        isOpen: true,
        title: 'Cannot Save Board',
        message: 'You must have at least one column'
      });
      return;
    }

    const boardData = {
      title: title.trim(),
      description: description.trim(),
      category: category.trim() || 'General',
      columns: columns.map(col => ({
        ...col,
        title: col.title.trim()
      }))
    };

    onSave(boardData);
  }

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} className="max-w-3xl w-full">
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between">
        <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
          Board Settings
        </h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Body */}
      <form onSubmit={handleSubmit} className="p-6 space-y-6 bg-os-modal max-h-[70vh] overflow-y-auto">
        {/* Board Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-os-text-primary">Board Information</h3>

          {/* Title */}
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Board Title *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My Kanban Board"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-modal text-os-text-primary"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Board description"
              rows={2}
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-modal text-os-text-primary resize-none"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Category
            </label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="General"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-modal text-os-text-primary"
            />
          </div>
        </div>

        {/* Columns */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-os-text-primary">Columns</h3>
            <button
              type="button"
              onClick={handleAddColumn}
              className="btn btn-quiet flex items-center gap-2 px-3 py-1.5 text-sm"
            >
              Add Column
            </button>
          </div>

          <div className="space-y-2">
            {columns.map((column, index) => (
              <div
                key={column.id}
                className="flex items-center gap-3 p-3 border border-os-border rounded-sm bg-os-card-secondary"
              >
                <GripVertical size={16} className="text-os-text-muted shrink-0" />

                {/* Column Name */}
                <input
                  type="text"
                  value={column.title}
                  onChange={(e) => handleUpdateColumn(index, 'title', e.target.value)}
                  className="flex-1 px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-modal text-os-text-primary"
                  placeholder="Column name"
                />

                {/* Color Picker */}
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={column.color}
                    onChange={(e) => handleUpdateColumn(index, 'color', e.target.value)}
                    className="w-10 h-10 rounded-sm border border-os-border cursor-pointer"
                  />
                </div>

                {/* Delete Button */}
                <button
                  type="button"
                  onClick={() => handleDeleteColumn(index)}
                  className="btn btn-danger-ghost p-2 shrink-0"
                  disabled={columns.length <= 1}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>

          {columns.length === 0 && (
            <div className="text-center text-os-text-muted text-sm py-4">
              No columns. Click "Add Column" to create one.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-os-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary px-4 py-2 text-sm"
          >
            Save Settings
          </button>
        </div>
      </form>

      {/* Alert Modal */}
      <ConfirmationModal
        isOpen={alertDialog.isOpen}
        onClose={() => setAlertDialog({ ...alertDialog, isOpen: false })}
        title={alertDialog.title}
        message={alertDialog.message}
        type="alert"
      />
    </BaseModal>
  );
}
