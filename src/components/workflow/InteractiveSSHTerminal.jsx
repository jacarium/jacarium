import { useState, useEffect, useRef } from 'react';
import { X, Terminal, ChevronRight, ChevronLeft } from 'lucide-react';
import useSSHSession from '../../hooks/useSSHSession';
import useSSHTabCompletion from '../../hooks/useSSHTabCompletion';
import SSHCommandSidebar from './ssh/SSHCommandSidebar';
import SSHCompletionList from './ssh/SSHCompletionList';
import SSHSessionStatus from './ssh/SSHSessionStatus';
import { stripAnsi } from './ssh/sshTerminalText';

const LINE_CLASS = {
  error: 'text-red-500',
  system: 'text-os-text-muted',
  input: 'text-os-blue'
};

/**
 * Terminal UI for an SSH node in interactive mode: output pane, an input
 * line with TAB completion, and the custom-commands sidebar. Rendered as a
 * modal on its own, or as the content of a floating window
 * (`floatingMode`, see FloatingSSHTerminal) which then supplies the chrome.
 *
 * The session itself (socket, output, exit) lives in useSSHSession and
 * completion in useSSHTabCompletion; this component is the keyboard glue
 * and the layout.
 */
export default function InteractiveSSHTerminal({
  sshConfig,
  onComplete,
  onCancel,
  floatingMode = false
}) {
  const [input, setInput] = useState('');
  const [showToolbar, setShowToolbar] = useState(true);
  const terminalRef = useRef(null);
  const inputRef = useRef(null);

  // The session hands completion echo to the completion hook, which in turn
  // writes to the session; `send` closes over the session's socket ref so
  // the circular reference is fine.
  const completion = useSSHTabCompletion({ send: (text) => session.send(text) });
  const session = useSSHSession({ sshConfig, onComplete, onOutput: completion.handleOutput });
  const { output, isConnected, exitCode, addOutput, send } = session;

  useEffect(() => {
    // Auto-scroll to bottom when new output arrives
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  const insertIntoInput = (text) => {
    setInput(text);
    inputRef.current?.focus();
  };

  const selectCompletion = (candidate) => {
    insertIntoInput(completion.select(candidate, input));
  };

  const handleSendInput = (e) => {
    e?.preventDefault();
    if (!input.trim() || !isConnected) return;

    // Show input in terminal, then send to the shell
    if (!send(input + '\n')) return;
    addOutput({ type: 'input', text: input });
    setInput('');
  };

  const handleKeyDown = (e) => {
    const { completions } = completion;

    // Handle completion list navigation
    if (completions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'Tab') {
        e.preventDefault();
        completion.move(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        completion.move(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        selectCompletion(completions[completion.selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        completion.clear();
        return;
      }
      // Close completions if user starts typing (the key event proceeds normally)
      if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
        completion.clear();
      }
    }

    // Normal key handling
    if (e.key === 'Tab') {
      e.preventDefault();
      if (isConnected) completion.request(input);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendInput();
    }
  };

  const handleExit = () => {
    if (!isConnected) return;

    // Show exit command in terminal, then send it
    if (!send('exit\n')) return;
    addOutput({ type: 'input', text: 'exit' });
  };

  const toolbarToggle = (
    <button
      onClick={() => setShowToolbar(!showToolbar)}
      className="p-1 hover:bg-os-card rounded-sm transition-colors"
      title={showToolbar ? 'Hide tools' : 'Show tools'}
    >
      {showToolbar ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
    </button>
  );

  // Render terminal content
  const terminalContentUI = (
    <div className="flex-1 flex overflow-hidden">
      {/* Main terminal area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Status bar for floating mode */}
        {floatingMode && (
          <div className="px-3 py-2 bg-os-card-secondary flex items-center gap-2 border-b border-os-border">
            {toolbarToggle}
            <SSHSessionStatus isConnected={isConnected} exitCode={exitCode} />
          </div>
        )}

        {/* Terminal Output */}
        <div
          ref={terminalRef}
          className="flex-1 overflow-y-auto p-3 bg-os-card font-mono text-xs terminal-content"
          style={{
            minHeight: floatingMode ? '300px' : '400px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'text',
            WebkitUserSelect: 'text',
            MozUserSelect: 'text',
            msUserSelect: 'text',
            cursor: 'text',
            pointerEvents: 'auto'
          }}
          tabIndex={0}
        >
          {output.map((line, index) => (
            <div
              key={index}
              className={LINE_CLASS[line.type] || 'text-os-text-primary'}
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                userSelect: 'text'
              }}
            >
              {line.type === 'input' ? '$ ' : ''}{stripAnsi(line.text)}
            </div>
          ))}
          {isConnected && (
            <div className="flex items-center text-os-text-primary" style={{ userSelect: 'none' }}>
              <span className="animate-pulse">▊</span>
            </div>
          )}
        </div>

        {/* Input Area */}
        {isConnected && (
          <div className="p-3 border-t border-os-border bg-os-card-secondary relative">
            {completion.completions.length > 0 && (
              <SSHCompletionList
                completions={completion.completions}
                selectedIndex={completion.selectedIndex}
                onSelect={selectCompletion}
              />
            )}

            <form onSubmit={handleSendInput} className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type command... (TAB for autocomplete)"
                className="flex-1 px-3 py-1.5 bg-os-input-bg text-os-text-primary border border-os-input-border rounded-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-xs"
                autoFocus
              />
              <button
                type="submit"
                disabled={!input.trim()}
                className="btn btn-primary px-3 py-1.5 text-xs"
              >
                Send
              </button>
              <button
                type="button"
                onClick={handleExit}
                className="btn btn-danger-solid px-3 py-1.5 text-xs"
              >
                Exit
              </button>
            </form>
          </div>
        )}

        {/* Footer - Close button when session ends */}
        {!floatingMode && !isConnected && exitCode !== null && (
          <div className="p-3 border-t border-os-border flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 bg-os-card-secondary hover:bg-os-card border border-os-border text-os-text-primary rounded-sm transition-colors text-xs"
            >
              Close
            </button>
          </div>
        )}
      </div>

      {/* Tools Sidebar (its modals render even while hidden) */}
      <SSHCommandSidebar visible={showToolbar} onInsertCommand={insertIntoInput} />
    </div>
  );

  // Return floating mode or modal mode
  if (floatingMode) {
    return terminalContentUI;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-os-card rounded-lg shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col border border-os-border">
        {/* Header - only in modal mode */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-os-border bg-os-card-secondary">
          <div className="flex items-center gap-2">
            {toolbarToggle}
            <Terminal size={16} className="text-os-text-secondary" />
            <span className="text-sm font-medium text-os-text-primary">
              SSH Terminal
            </span>
            <span className="text-xs text-os-text-muted">
              {sshConfig.username}@{sshConfig.host}
            </span>
            <SSHSessionStatus isConnected={isConnected} exitCode={exitCode} />
          </div>
          <button
            onClick={onCancel}
            className="p-1 hover:bg-os-card transition-colors rounded-sm"
          >
            <X size={16} className="text-os-text-secondary" />
          </button>
        </div>
        {terminalContentUI}
      </div>
    </div>
  );
}
