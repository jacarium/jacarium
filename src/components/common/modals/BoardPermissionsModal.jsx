import { useState, useEffect } from 'react';
import BaseModal from './BaseModal';
import { Shield, Trash2, X } from 'lucide-react';
import { getMachineId } from '../../../utils/cloudDocuments';

/**
 * BoardPermissionsModal - Manage read/write permissions for boards
 *
 * Permissions structure:
 * {
 *   machineId: 'read' | 'write'
 * }
 */
export default function BoardPermissionsModal({
  isOpen,
  onClose,
  board,
  boards, // For bulk operations
  onSave,
}) {
  const [permissions, setPermissions] = useState({});
  const [newMachineId, setNewMachineId] = useState('');
  const [newPermission, setNewPermission] = useState('read');
  const [currentMachineId, setCurrentMachineId] = useState('');

  // Support both single board and multiple boards
  const isMultiple = boards && boards.length > 0;
  const targetBoards = isMultiple ? boards : (board ? [board] : []);

  useEffect(() => {
    // For bulk operations, start with empty permissions (override mode)
    // For single board, copy existing permissions
    if (isMultiple) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPermissions({});
    } else if (board && board.permissions) {
      setPermissions({ ...board.permissions });
    } else {
      setPermissions({});
    }
  }, [board, isMultiple]);

  useEffect(() => {
    async function loadMachineId() {
      const id = await getMachineId();
      setCurrentMachineId(id);
    }
    loadMachineId();
  }, []);

  function handleAddPermission() {
    if (!newMachineId.trim()) return;

    setPermissions({
      ...permissions,
      [newMachineId.trim()]: newPermission
    });
    setNewMachineId('');
    setNewPermission('read');
  }

  function handleRemovePermission(machineId) {
    const updated = { ...permissions };
    delete updated[machineId];
    setPermissions(updated);
  }

  function handleSave() {
    onSave && onSave(permissions);
    onClose();
  }

  if (!board && !isMultiple) return null;

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={onClose}
      className="max-w-2xl w-full"
    >
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={18} className="text-purple-600" />
          <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
            {isMultiple ? `Manage Permissions (${targetBoards.length} Boards)` : 'Manage Permissions'}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="p-6 space-y-6 bg-os-modal max-h-[70vh] overflow-y-auto">
        {/* Board Info */}
        {isMultiple ? (
          <div className="bg-os-card-secondary p-4 rounded-lg">
            <div className="text-sm font-medium text-os-text-primary mb-2">
              Bulk Permissions Override
            </div>
            <div className="text-xs text-os-text-muted mb-2">
              Setting permissions for {targetBoards.length} board{targetBoards.length !== 1 ? 's' : ''}
            </div>
            <div className="text-xs text-yellow-600 dark:text-yellow-500 bg-yellow-50 dark:bg-yellow-900/20 p-2 rounded-sm">
              ⚠️ This will override existing permissions on all selected boards
            </div>
          </div>
        ) : (
          <div className="bg-os-card-secondary p-4 rounded-lg">
            <div className="text-sm font-medium text-os-text-primary mb-1">
              {board.title}
            </div>
            <div className="text-xs text-os-text-muted">
              Owner: {board.ownerId || 'Not set'}
            </div>
            <div className="text-xs text-os-text-muted">
              Current Machine: {currentMachineId || 'Loading...'}
            </div>
          </div>
        )}

        {/* Add Permission */}
        <div className="space-y-2">
          <label className="block text-xs text-os-text-primary uppercase tracking-wide">
            Add Permission
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={newMachineId}
              onChange={(e) => setNewMachineId(e.target.value)}
              placeholder="Machine ID (username@hostname)"
              className="flex-1 px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-hidden text-sm bg-os-modal text-os-text-primary font-mono"
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleAddPermission();
                }
              }}
            />
            <select
              value={newPermission}
              onChange={(e) => setNewPermission(e.target.value)}
              className="px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-hidden text-sm bg-os-modal text-os-text-primary"
            >
              <option value="read">Read Only</option>
              <option value="write">Read & Write</option>
            </select>
            <button
              onClick={handleAddPermission}
              className="btn btn-brand px-4 py-2 text-sm flex items-center gap-2"
            >
              Add
            </button>
          </div>
          <p className="text-xs text-os-text-muted">
            Machine IDs are in format: username@hostname (e.g., user@laptop-123)
          </p>
        </div>

        {/* Permissions List */}
        <div className="space-y-2">
          <label className="block text-xs text-os-text-primary uppercase tracking-wide">
            {isMultiple ? 'New Permissions (Will Override All)' : 'Current Permissions'}
          </label>
          {Object.keys(permissions).length === 0 ? (
            <div className="text-sm text-os-text-muted text-center py-6">
              {isMultiple
                ? 'No permissions set. Shared boards are visible to everyone on your home server\'s team; others can view these but not edit them.'
                : 'No permissions set. Shared boards are visible to everyone on your home server\'s team; others can view this one but not edit it.'}
            </div>
          ) : (
            <div className="space-y-2">
              {Object.entries(permissions).map(([machineId, permission]) => (
                <div
                  key={machineId}
                  className="flex items-center justify-between p-3 bg-os-card-secondary rounded-lg border border-os-border"
                >
                  <div className="flex-1">
                    <div className="text-sm font-mono text-os-text-primary">
                      {machineId}
                    </div>
                    <div className="text-xs text-os-text-muted">
                      {permission === 'write' ? 'Read & Write' : 'Read Only'}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemovePermission(machineId)}
                    className="btn btn-danger-ghost p-2"
                    title="Remove permission"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="btn btn-brand flex items-center gap-2 px-4 py-2 text-sm"
        >
          Save Permissions
        </button>
      </div>
    </BaseModal>
  );
}
