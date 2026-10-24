import { useState, useRef, useEffect } from 'react';
import { Workflow, X, Check, ChevronRight } from 'lucide-react';
import { getWorkflows } from '../../../utils/workflows';
import { executeWorkflowInBrowser } from '../../../utils/workflowExecution';
import { formatNodeValue } from '../../workflow/workflowNodeUtils';
import FloatingSSHTerminal from '../../workflow/FloatingSSHTerminal';

/**
 * QuickWorkflow - Execute workflows from document editor
 *
 * Features:
 * - Select workflow from list
 * - Provide inputs if BeginPlay has data outputs
 * - Execute workflow in background
 * - Show result from Result node
 * - Insert result into document
 *
 * An SSH node in interactive mode opens the same floating terminal as the
 * Workflow Builder; it stays open independently of this popup.
 */
export default function QuickWorkflow({
  visible,
  position,
  onClose,
  onInsert,
}) {
  const [workflows, setWorkflows] = useState([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState(null);
  const [inputs, setInputs] = useState({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const [popupPos, setPopupPos] = useState(position);
  // { config } while an SSH node waits on the terminal; the engine's promise
  // is resolved through the ref when the session ends
  const [interactiveSSH, setInteractiveSSH] = useState(null);
  const interactiveSSHResolveRef = useRef(null);

  useEffect(() => {
    if (visible) {
      // Intentional init-on-open: reload workflows and reset the previous
      // run's selection/result (async loader sets state post-await).
      loadWorkflows();
      // Reset workflow selection when reopening (but don't affect SSH terminal)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedWorkflow(null);
      setInputs({});
      setResult(null);
      setError(null);
    }
  }, [visible]);

  useEffect(() => {
    // Intentional prop-to-state sync: the popup tracks the caller-provided
    // anchor until the user drags it elsewhere.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPopupPos(position);
  }, [position]);

  async function loadWorkflows() {
    const allWorkflows = await getWorkflows();
    setWorkflows(allWorkflows);
  }

  function handleWorkflowSelect(workflow) {
    setSelectedWorkflow(workflow);
    setResult(null);
    setError(null);

    // Check if workflow needs inputs from BeginPlay node's data.inputs
    const beginPlayNode = workflow.nodes?.find(n => n.type === 'beginplay');
    if (beginPlayNode?.data?.inputs) {
      // Initialize input fields from BeginPlay's defined inputs
      const initialInputs = {};
      Object.keys(beginPlayNode.data.inputs).forEach(key => {
        initialInputs[key] = '';
      });
      setInputs(initialInputs);
    } else {
      setInputs({});
    }
  }

  async function handleExecute() {
    if (!selectedWorkflow) return;

    console.log('[QuickWorkflow] Starting browser execution');
    setExecuting(true);
    setError(null);
    setResult(null);

    try {
      // Filter out empty inputs - let execution use connected values instead
      const filteredInputs = {};
      Object.entries(inputs).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') {
          filteredInputs[key] = value;
        }
      });

      console.log('[QuickWorkflow] Filtered inputs:', filteredInputs);
      console.log('[QuickWorkflow] Workflow:', selectedWorkflow.title);

      // Execute workflow in browser with SSH terminal support
      const { outputs, error } = await executeWorkflowInBrowser(
        selectedWorkflow,
        filteredInputs,
        null, // onNodeUpdate callback
        // Interactive SSH: park the engine until the floating terminal resolves
        (nodeId, sshConfig) => new Promise((resolve) => {
          interactiveSSHResolveRef.current = resolve;
          setInteractiveSSH({ config: sshConfig });
        })
      );

      if (error) {
        setError(error);
      } else {
        let workflowResult = null;

        // Look for Result node output
        for (const [nodeId, output] of Object.entries(outputs)) {
          const node = selectedWorkflow.nodes?.find(n => n.id === nodeId);
          if (node && node.type === 'result') {
            workflowResult = output;
            break;
          }
        }

        // If no Result node found, use the last output
        if (workflowResult === null) {
          const keys = Object.keys(outputs);
          if (keys.length > 0) {
            workflowResult = outputs[keys[keys.length - 1]];
          }
        }

        console.log('[QuickWorkflow] Execution complete, result:', workflowResult);
        setResult(workflowResult);
      }
    } catch (err) {
      console.error('[QuickWorkflow] Execution error:', err);
      setError(err.message || 'Failed to execute workflow');
    } finally {
      setExecuting(false);
    }
  }

  function handleInsertResult() {
    if (result !== null && result !== undefined) {
      onInsert(formatNodeValue(result));
      handleClose();
    }
  }

  function handleClose() {
    // Close QuickWorkflow popup (SSH terminal stays open independently)
    setSelectedWorkflow(null);
    setInputs({});
    setResult(null);
    setError(null);
    onClose();
  }

  // The terminal finished (or was cancelled): hand its result to the engine
  function handleInteractiveSSHComplete(sshResult) {
    const resolve = interactiveSSHResolveRef.current;
    interactiveSSHResolveRef.current = null;
    setInteractiveSSH(null);
    resolve?.(sshResult);
  }

  function handleInteractiveSSHCancel() {
    handleInteractiveSSHComplete({ stdout: '', stderr: 'User cancelled', exitCode: 130, success: false });
  }

  function handleMouseDown(e) {
    if (e.target.closest('.drag-handle')) {
      setIsDragging(true);
      dragStartRef.current = {
        left: popupPos.x,
        top: popupPos.y,
        x: e.clientX,
        y: e.clientY
      };
    }
  }

  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      const newLeft = dragStartRef.current.left + deltaX;
      const newTop = dragStartRef.current.top + deltaY;

      setPopupPos({ x: Math.max(0, newLeft), y: Math.max(0, newTop) });
    }

    function handleMouseUp() {
      setIsDragging(false);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <>
      {/* QuickWorkflow Popup - only show when visible */}
      {visible && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={handleClose}
          />

      {/* Popup */}
      <div
        className="fixed z-50 bg-os-card rounded-lg shadow-2xl border border-os-border"
        style={{
          left: `${popupPos.x}px`,
          top: `${popupPos.y}px`,
          width: '500px',
          maxHeight: '600px',
          cursor: isDragging ? 'grabbing' : 'default'
        }}
        onMouseDown={handleMouseDown}
      >
        {/* Header */}
        <div className="drag-handle flex items-center justify-between p-3 border-b border-os-border bg-linear-to-r from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 cursor-grab active:cursor-grabbing rounded-t-lg">
          <div className="flex items-center gap-2">
            <Workflow size={16} className="text-purple-600 dark:text-purple-300" />
            <span className="text-sm font-semibold text-purple-900 dark:text-purple-200">Quick Workflow</span>
          </div>
          <button
            onClick={handleClose}
            className="btn btn-brand-ghost p-1"
          >
            <X size={16} className="text-purple-700 dark:text-purple-300" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto" style={{ maxHeight: '500px' }}>
          {!selectedWorkflow ? (
            // Workflow List
            <>
              <div className="text-xs text-os-text-secondary mb-3">Select a workflow to execute:</div>
              <div className="space-y-1">
                {workflows.length === 0 ? (
                  <div className="text-sm text-os-text-muted text-center py-8">
                    No workflows available
                  </div>
                ) : (
                  workflows.map(workflow => (
                    <button
                      key={workflow.id}
                      onClick={() => handleWorkflowSelect(workflow)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary rounded-sm transition-colors group"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Workflow size={14} className="text-purple-600 dark:text-purple-300 shrink-0" />
                        <span className="truncate">{workflow.title}</span>
                        {workflow.category && (
                          <span className="text-xs text-os-text-muted">({workflow.category})</span>
                        )}
                      </div>
                      <ChevronRight size={14} className="text-os-text-muted group-hover:text-purple-600 dark:group-hover:text-purple-300 shrink-0" />
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            // Workflow Execution
            <>
              {/* Workflow Info */}
              <div className="mb-4 pb-3 border-b border-os-border">
                <div className="flex items-center gap-2">
                  <Workflow size={16} className="text-purple-600 dark:text-purple-300" />
                  <span className="font-medium text-sm text-os-text-primary">{selectedWorkflow.title}</span>
                </div>
                <button
                  onClick={() => {
                    setSelectedWorkflow(null);
                    setResult(null);
                    setError(null);
                  }}
                  className="text-xs text-purple-600 dark:text-purple-300 hover:text-purple-700 dark:hover:text-purple-200 mt-1"
                >
                  ← Choose different workflow
                </button>
              </div>

              {/* Inputs */}
              {Object.keys(inputs).length > 0 && !result && (
                <div className="mb-4">
                  <div className="text-xs text-os-text-secondary mb-2">
                    Inputs <span className="text-os-text-muted">(optional if connected in workflow)</span>:
                  </div>
                  <div className="space-y-2">
                    {Object.keys(inputs).map(key => (
                      <div key={key}>
                        <label className="text-xs text-os-text-secondary mb-1 block">{key}</label>
                        <input
                          type="text"
                          value={inputs[key]}
                          onChange={(e) => setInputs(prev => ({ ...prev, [key]: e.target.value }))}
                          className="w-full px-2 py-1 text-sm border border-os-input-border bg-os-input-bg text-os-text-primary rounded-sm focus:outline-hidden focus:border-purple-500"
                          placeholder={`Enter ${key}... (or leave empty to use connected value)`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Execute Button */}
              {!result && (
                <button
                  onClick={handleExecute}
                  disabled={executing}
                  className="btn btn-brand w-full flex items-center justify-center gap-2 px-4 py-2 text-sm"
                >
                  {executing ? 'Executing...' : 'Execute Workflow'}
                </button>
              )}

              {/* Error */}
              {error && (
                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-700 dark:text-red-300">
                  <div className="font-medium mb-1">Error:</div>
                  <div className="text-xs">{error}</div>
                </div>
              )}

              {/* Result */}
              {result !== null && result !== undefined && (
                <div className="mt-4">
                  <div className="text-xs text-os-text-secondary mb-2">Result:</div>
                  <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-sm">
                    <pre className="text-xs text-green-900 dark:text-green-300 whitespace-pre-wrap wrap-break-word font-mono">
                      {formatNodeValue(result)}
                    </pre>
                  </div>

                  {/* Insert Button */}
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={handleInsertResult}
                      className="btn btn-success flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm"
                    >
                      <Check size={14} />
                      Insert into Document
                    </button>
                    <button
                      onClick={() => {
                        setResult(null);
                        setError(null);
                      }}
                      className="px-4 py-2 bg-os-card-secondary text-os-text-primary text-sm rounded-sm hover:bg-os-card-tertiary transition-colors"
                    >
                      Run Again
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
        </>
      )}

      {/* Interactive SSH Terminal - stays open independently of the popup */}
      {interactiveSSH && (
        <FloatingSSHTerminal
          sshConfig={interactiveSSH.config}
          onComplete={handleInteractiveSSHComplete}
          onCancel={handleInteractiveSSHCancel}
        />
      )}
    </>
  );
}
