import { useState, useEffect, useRef } from 'react';
import { parseCompletionOutput, applyCompletion } from '../components/workflow/ssh/sshTerminalText';

/** How long to wait for the shell to finish echoing completions. */
const COMPLETION_SETTLE_MS = 200;
/** Keep hiding output after the line-clearing Ctrl+U so its echo never shows. */
const COMPLETION_QUIET_MS = 300;

/**
 * TAB completion for the interactive SSH terminal, done the way a user at
 * the shell would: the current input plus TAB TAB is sent to the shell, the
 * echo is captured (not displayed), parsed into candidates, and the shell's
 * line is cleared again with Ctrl+U. The candidates are shown in a list the
 * user walks with the arrow keys.
 *
 * @param {Object}   params
 * @param {Function} params.send - write text to the shell; returns false when disconnected
 */
export default function useSSHTabCompletion({ send }) {
  const [completions, setCompletions] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prefixRef = useRef(''); // the input when TAB was pressed (ref: needed synchronously)
  const waitingRef = useRef(false); // shell output is completion echo while set
  const bufferRef = useRef('');
  const settleTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  function clear() {
    setCompletions([]);
    setSelectedIndex(0);
  }

  /** TAB pressed: ask the shell for the completions of `input`. */
  function request(input) {
    if (!input.trim()) return;

    console.log('[Tab Completion] Requesting completion for:', input);
    prefixRef.current = input;
    setCompletions([]);
    bufferRef.current = '';
    waitingRef.current = true;

    // The shell sees us typing at the prompt and pressing TAB twice (shows all options)
    send(input + '\t\t');
  }

  /** Shell output arrived: true when it was completion echo (consumed). */
  function handleOutput(data) {
    if (!waitingRef.current) return false;

    bufferRef.current += data;
    clearTimeout(settleTimerRef.current);

    // The shell typically sends everything at once; parse once it goes quiet
    settleTimerRef.current = setTimeout(() => {
      const buffer = bufferRef.current;
      bufferRef.current = '';
      settleTimerRef.current = null;

      console.log('[Tab Completion] Raw buffer:', JSON.stringify(buffer), 'for input:', prefixRef.current);

      // Clear the shell's input line (Ctrl+U) and keep swallowing output a
      // little longer so the response to that never reaches the terminal
      if (send('\x15')) {
        setTimeout(() => {
          waitingRef.current = false;
        }, COMPLETION_QUIET_MS);
      } else {
        waitingRef.current = false;
      }

      const found = parseCompletionOutput(buffer, prefixRef.current);
      console.log('[Tab Completion] Final completions:', found);

      // One candidate is shown as a list too, so the user sees what was found
      if (found.length > 0) {
        setCompletions(found);
        setSelectedIndex(0);
      }
    }, COMPLETION_SETTLE_MS);

    return true;
  }

  /** Pick a candidate: the new input text, with the list closed. */
  function select(completion, input) {
    console.log('[Tab Completion] Selecting:', completion, 'for input:', input);
    clear();
    return applyCompletion(input, completion);
  }

  /** Arrow keys / TAB: move the highlight, wrapping around. */
  function move(delta) {
    setSelectedIndex(prev => (prev + delta + completions.length) % completions.length);
  }

  return { completions, selectedIndex, request, handleOutput, select, move, clear };
}
