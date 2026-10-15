import { useState, useRef, useCallback, useEffect } from 'react';
import { executeWorkflowInBrowser } from '../utils/workflowExecution';
import { clearNodeStatuses, clearNodeOutputs } from '../components/workflow/workflowNodeUtils';

const STATUS_CLEAR_DELAY_MS = 2000;

/**
 * Owns the run/stop/clear lifecycle of the workflow canvas: execution flag,
 * abort signalling, live node status/result updates and the interactive SSH
 * hand-off. Everything that mutates nodes goes through `setNodes`.
 *
 * @param {Object} params
 * @param {Array}    params.nodes
 * @param {Array}    params.edges
 * @param {Function} params.setNodes
 * @param {Object}   [params.currentWorkflow]
 */
export default function useWorkflowExecution({ nodes, edges, setNodes, currentWorkflow }) {
  const [isExecuting, setIsExecuting] = useState(false);
  // { config } while an SSH node is waiting on the interactive terminal
  const [interactiveSSH, setInteractiveSSH] = useState(null);
  const interactiveSSHResolve = useRef(null);
  const executionAborted = useRef(false);
  const statusClearTimer = useRef(null);

  // Abort a run if the builder unmounts mid-execution
  useEffect(() => {
    return () => {
      executionAborted.current = true;
      clearTimeout(statusClearTimer.current);
    };
  }, []);

  /** Apply a status/result update from the engine to the matching node. */
  const applyNodeUpdate = useCallback((nodeId, status, result) => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== nodeId) return n;

        const updatedData = { ...n.data, status };

        if (status === 'error') {
          updatedData.error = result;
        } else if (status === 'complete') {
          updatedData.error = null;

          if (result !== null && result !== undefined) {
            if (n.type === 'visualizer') updatedData.data = result;
            if (n.type === 'result') updatedData.outputValue = result;
            if (n.type === 'comparison') updatedData.result = result;
          }
        }

        return { ...n, data: updatedData };
      })
    );
  }, [setNodes]);

  /** Resolve a pending interactive SSH session (if any) and close the terminal. */
  const completeInteractiveSSH = useCallback((result) => {
    const resolve = interactiveSSHResolve.current;
    interactiveSSHResolve.current = null;
    setInteractiveSSH(null);
    resolve?.(result);
  }, []);

  const cancelInteractiveSSH = useCallback(() => {
    completeInteractiveSSH({ stdout: '', stderr: 'User cancelled', exitCode: 130, success: false });
  }, [completeInteractiveSSH]);

  const executeWorkflow = useCallback(async () => {
    if (isExecuting) return;

    clearTimeout(statusClearTimer.current);
    setIsExecuting(true);
    executionAborted.current = false;

    try {
      const workflow = {
        id: currentWorkflow?.id,
        title: currentWorkflow?.title || 'Untitled',
        nodes,
        edges
      };

      const { outputs, error } = await executeWorkflowInBrowser(
        workflow,
        {},
        applyNodeUpdate,
        // Interactive SSH: park the engine until the floating terminal resolves
        (nodeId, sshConfig) => new Promise((resolve) => {
          interactiveSSHResolve.current = resolve;
          setInteractiveSSH({ config: sshConfig });
        }),
        () => executionAborted.current
      );

      if (error) {
        console.error('[Workflow Builder] Execution error:', error);
      } else {
        console.log('[Workflow Builder] Execution complete:', outputs);
      }
    } finally {
      setIsExecuting(false);

      statusClearTimer.current = setTimeout(() => {
        setNodes(clearNodeStatuses);
      }, STATUS_CLEAR_DELAY_MS);
    }
  }, [isExecuting, nodes, edges, currentWorkflow, applyNodeUpdate, setNodes]);

  /** Signal the engine to halt without touching node visuals. */
  const abortExecution = useCallback(() => {
    executionAborted.current = true;
    setIsExecuting(false);
    if (interactiveSSHResolve.current) {
      cancelInteractiveSSH();
    }
  }, [cancelInteractiveSSH]);

  /** Stop button: halt and clear all processing states immediately. */
  const stopWorkflow = useCallback(() => {
    abortExecution();
    setNodes(clearNodeStatuses);
  }, [abortExecution, setNodes]);

  /** Clear button: wipe results shown in visualiser-style nodes. */
  const clearOutputs = useCallback(() => {
    clearTimeout(statusClearTimer.current);
    setNodes(clearNodeOutputs);
  }, [setNodes]);

  return {
    isExecuting,
    executeWorkflow,
    stopWorkflow,
    abortExecution,
    clearOutputs,
    interactiveSSH,
    completeInteractiveSSH,
    cancelInteractiveSSH
  };
}
