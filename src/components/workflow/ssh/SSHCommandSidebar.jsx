import { useState, useEffect, useRef } from 'react';
import { Plus, Edit2, Trash2, GripVertical } from 'lucide-react';
import {
  getSSHCommands,
  createSSHCommand,
  updateSSHCommand,
  deleteSSHCommand,
  migrateSSHCommandsFromLocalStorage
} from '../../../utils/sshCommands';
import ConfirmationModal from '../../common/modals/ConfirmationModal';
import { useConfirmation } from '../../../hooks/useConfirmation';
import { useNotifications } from '../../../contexts/NotificationContext';
import SSHCommandEditModal from './SSHCommandEditModal';
import SSHCommandVariablesModal from './SSHCommandVariablesModal';
import { extractVariables, replaceVariables } from './sshTerminalText';

const MIN_WIDTH = 250;
const MAX_WIDTH = 600;
const clampWidth = (width) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));

/**
 * The resizable "Custom Commands" panel beside the terminal: saved SSH
 * commands (IndexedDB) that are inserted into the input on click, asking
 * for their {{VARIABLE}} values first when they have any. Its modals are
 * rendered even while the panel is hidden so an open one survives toggling.
 *
 * @param {boolean}  visible - show the panel (the modals render regardless)
 * @param {Function} onInsertCommand - put text into the terminal input
 */
export default function SSHCommandSidebar({ visible, onInsertCommand }) {
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('ssh-toolbar-width');
    return saved ? parseInt(saved) : 300;
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  const [customCommands, setCustomCommands] = useState([]);
  const [editingCommand, setEditingCommand] = useState(null);
  const [showCommandModal, setShowCommandModal] = useState(false);
  const [pendingCommand, setPendingCommand] = useState(null); // waiting for its variable values
  const [variableValues, setVariableValues] = useState({});

  // Load SSH commands from IndexedDB on mount
  useEffect(() => {
    async function loadCommands() {
      try {
        // Migrate from localStorage if needed
        await migrateSSHCommandsFromLocalStorage();

        setCustomCommands(await getSSHCommands());
      } catch (error) {
        console.error('[SSH Terminal] Failed to load commands:', error);
      }
    }

    loadCommands();
  }, []);

  // Save toolbar width to localStorage
  useEffect(() => {
    localStorage.setItem('ssh-toolbar-width', width.toString());
  }, [width]);

  // Resize: the DOM width follows the mouse directly (one frame at a time)
  // and state is only written on mouseup, so dragging never re-renders the
  // command list.
  useEffect(() => {
    if (!isResizing) return;

    let rafId = null;
    const widthAt = (clientX) => clampWidth(resizeStartWidth.current + (resizeStartX.current - clientX));

    const handleMouseMove = (e) => {
      if (rafId) return; // Skip if already scheduled

      rafId = requestAnimationFrame(() => {
        if (panelRef.current) {
          panelRef.current.style.width = `${widthAt(e.clientX)}px`;
        }
        rafId = null;
      });
    };

    const handleMouseUp = (e) => {
      setIsResizing(false);
      setWidth(widthAt(e.clientX));
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const handleResizeStart = (e) => {
    e.preventDefault();
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = width;
    setIsResizing(true);
  };

  // Click a saved command: insert it, or ask for its variables first
  const handleCommandClick = (cmd) => {
    const variables = extractVariables(cmd.command);

    if (variables.length === 0) {
      onInsertCommand(cmd.command);
    } else {
      setPendingCommand(cmd);
      setVariableValues(
        variables.reduce((acc, v) => ({ ...acc, [v]: '' }), {})
      );
    }
  };

  const closeVariablesModal = () => {
    setPendingCommand(null);
    setVariableValues({});
  };

  const handleVariableSubmit = () => {
    if (!pendingCommand) return;

    onInsertCommand(replaceVariables(pendingCommand.command, variableValues));
    closeVariablesModal();
  };

  const openCommandModal = (command) => {
    setEditingCommand(command);
    setShowCommandModal(true);
  };

  const closeCommandModal = () => {
    setShowCommandModal(false);
    setEditingCommand(null);
  };

  const handleSaveCommand = async (commandData) => {
    try {
      if (editingCommand) {
        await updateSSHCommand(editingCommand.id, commandData);
      } else {
        await createSSHCommand(commandData);
      }

      setCustomCommands(await getSSHCommands());
      closeCommandModal();
    } catch (error) {
      console.error('[SSH Terminal] Failed to save command:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: 'Failed to save command: ' + error.message
      });
    }
  };

  const handleDeleteCommand = async (id) => {
    if (await confirm({
      title: 'Delete Command',
      message: 'Delete this command?',
      type: 'danger',
      confirmLabel: 'Delete',
    })) {
      try {
        await deleteSSHCommand(id);
        setCustomCommands(await getSSHCommands());
      } catch (error) {
        console.error('[SSH Terminal] Failed to delete command:', error);
        addNotification({
          type: 'error',
          title: 'Delete Failed',
          message: 'Failed to delete command: ' + error.message
        });
      }
    }
  };

  return (
    <>
      {visible && (
        <>
          {/* Resize handle */}
          <div
            className="w-1 bg-os-border hover:bg-os-blue cursor-col-resize flex items-center justify-center transition-colors"
            onMouseDown={handleResizeStart}
            style={{
              touchAction: 'none',
              userSelect: 'none'
            }}
          >
            <GripVertical size={12} className="text-os-text-muted" />
          </div>

          {/* Sidebar content */}
          <div
            ref={panelRef}
            className="bg-os-card-secondary border-l border-os-border flex flex-col transition-none"
            style={{
              width: `${width}px`,
              minWidth: `${MIN_WIDTH}px`,
              maxWidth: `${MAX_WIDTH}px`,
              willChange: isResizing ? 'width' : 'auto'
            }}
          >
            {/* Sidebar header */}
            <div className="px-3 py-2 border-b border-os-border flex items-center justify-between">
              <span className="text-xs font-medium text-os-text-primary">Custom Commands</span>
              <button
                onClick={() => openCommandModal(null)}
                className="p-1 hover:bg-os-card rounded-sm transition-colors"
                title="Add command"
              >
                <Plus size={14} className="text-os-text-secondary" />
              </button>
            </div>

            {/* Commands list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {customCommands.map(cmd => (
                <div
                  key={cmd.id}
                  className="p-2 bg-os-card border border-os-border rounded-sm hover:border-os-blue transition-colors group"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <button
                      onClick={() => handleCommandClick(cmd)}
                      className="flex-1 text-left"
                    >
                      <div className="text-xs font-medium text-os-text-primary group-hover:text-os-blue transition-colors">
                        {cmd.name}
                      </div>
                      {cmd.description && (
                        <div className="text-xs text-os-text-muted mt-0.5">
                          {cmd.description}
                        </div>
                      )}
                    </button>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => openCommandModal(cmd)}
                        className="p-1 hover:bg-os-card-secondary rounded-sm"
                        title="Edit"
                      >
                        <Edit2 size={12} className="text-os-text-secondary" />
                      </button>
                      <button
                        onClick={() => handleDeleteCommand(cmd.id)}
                        className="p-1 hover:bg-os-card-secondary rounded-sm"
                        title="Delete"
                      >
                        <Trash2 size={12} className="text-red-500" />
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-os-text-muted font-mono bg-os-card-secondary px-2 py-1 rounded-sm">
                    {cmd.command}
                  </div>
                </div>
              ))}
              {customCommands.length === 0 && (
                <div className="text-xs text-os-text-muted text-center py-8">
                  No commands yet. Click + to add one.
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {showCommandModal && (
        <SSHCommandEditModal command={editingCommand} onSave={handleSaveCommand} onClose={closeCommandModal} />
      )}
      {pendingCommand && (
        <SSHCommandVariablesModal
          command={pendingCommand}
          values={variableValues}
          onChange={(name, value) => setVariableValues(prev => ({ ...prev, [name]: value }))}
          onSubmit={handleVariableSubmit}
          onClose={closeVariablesModal}
        />
      )}
      <ConfirmationModal {...confirmationProps} />
    </>
  );
}
