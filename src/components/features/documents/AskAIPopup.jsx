import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, X, RefreshCw, Check, Trash2 } from 'lucide-react';
import { getBackendUrl } from '../../../utils/backendUrl';
import { NO_AI_PROVIDER_MESSAGE, resolveAiRequestSettings, savedAiChatSettings } from '../../../utils/aiRequestSettings';
import { streamAiReply, truncationMessage, CONTINUE_PROMPT } from '../../../utils/aiStream';

/**
 * AskAIPopup - Ask AI about selected text
 *
 * Features:
 * - Display selected text
 * - Optional prompt input
 * - AI response with loading state
 * - Insert response (all or selected)
 * - Draggable popup
 */
export default function AskAIPopup({
  visible,
  x,
  y,
  selectedText,
  onInsert,
  onCancel,
}) {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState(null);           // 'waiting' | 'thinking' | 'answering' while loading
  const [truncated, setTruncated] = useState(false);  // the token limit cut the reply off (the limit, when known)
  const abortRef = useRef(null);
  const firstChunkRef = useRef(true);
  const [selectedResponse, setSelectedResponse] = useState('');
  const [backendStatus] = useState('online');
  const [popupSize, setPopupSize] = useState({ width: 500, height: 600 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [draggedPos, setDraggedPos] = useState(null);
  const [editableSelectedText, setEditableSelectedText] = useState('');

  const promptRef = useRef(null);
  const responseRef = useRef(null);
  const dragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const resizeStartRef = useRef({ width: 0, height: 0, x: 0, y: 0 });

  // Use dragged position if dragging, otherwise use props
  const popupPos = draggedPos || { x, y };

  // Reset dragged position when popup closes
  // Reset state when the popup closes (cleanup runs on visible -> false and
  // unmount; initial state already covers first mount)
  useEffect(() => {
    if (!visible) return undefined;
    return () => {
      setDraggedPos(null);
      setPrompt('');
      setResponse('');
      setSelectedResponse('');
      setEditableSelectedText('');
    };
  }, [visible]);

  // Focus prompt input when popup opens
  useEffect(() => {
    if (visible && promptRef.current) {
      setTimeout(() => {
        promptRef.current?.focus();
      }, 100);
    }
  }, [visible]);

  // Update editable text when selectedText changes
  useEffect(() => {
    if (visible && selectedText) {
      // Intentional prop-to-state sync: the popup edits a copy of the
      // caller-provided selection.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditableSelectedText(selectedText);
    }
  }, [visible, selectedText]);

  // Handle dragging
  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      const newLeft = dragStartRef.current.left + deltaX;
      const newTop = dragStartRef.current.top + deltaY;

      setDraggedPos({ x: newLeft, y: newTop });
    }

    function handleMouseUp() {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  // Handle resizing
  useEffect(() => {
    if (!isResizing) return;

    function handleMouseMove(e) {
      const deltaX = e.clientX - resizeStartRef.current.x;
      const deltaY = e.clientY - resizeStartRef.current.y;

      const newWidth = Math.max(300, resizeStartRef.current.width + deltaX);
      const newHeight = Math.max(400, resizeStartRef.current.height + deltaY);

      setPopupSize({ width: newWidth, height: newHeight });
    }

    function handleMouseUp() {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const handleSubmit = async () => {
    if (!editableSelectedText.trim()) return;

    setLoading(true);
    setResponse('');

    // Settings > Default AI through /api/ai/models (src/utils/aiRequestSettings.js)
    let aiSettings = null;
    try {
      aiSettings = await resolveAiRequestSettings({ saved: savedAiChatSettings() });
    } catch (error) {
      setResponse('Error: ' + error.message);
      setLoading(false);
      return;
    }
    if (!aiSettings) {
      setResponse(NO_AI_PROVIDER_MESSAGE);
      setLoading(false);
      return;
    }

    const fullMessage = prompt.trim()
      ? `${prompt}\n\n${editableSelectedText}`
      : editableSelectedText;

    await runAsk({ aiSettings, message: fullMessage });
  };

  // One request, streamed (src/utils/aiStream.js): the reply grows as it arrives, a reasoning model's thinking
  // shows as "Thinking...", Cancel aborts, no total timeout - only the idle one. `append` keeps the reply so far.
  const runAsk = async ({ aiSettings, message, append = false }) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setPhase('waiting');
    setTruncated(false);
    if (!append) setResponse('');
    firstChunkRef.current = true;
    try {
      const result = await streamAiReply({
        url: `${await getBackendUrl()}/api/ai/ask`,
        signal: controller.signal,
        body: { message, provider: aiSettings.provider, model: aiSettings.model, temperature: aiSettings.temperature, maxTokens: aiSettings.maxTokens, stream: true },
        onEvent: (ev) => {
          if (ev.type === 'thinking_start' || ev.type === 'thinking') setPhase('thinking');
          else if (ev.type === 'content' && ev.content) {
            setPhase('answering');
            const piece = (firstChunkRef.current && append ? '\n\n' : '') + ev.content;
            firstChunkRef.current = false;
            setResponse((prev) => prev + piece);
          }
        },
      });
      if (!result.content && !append) setResponse(result.thinking ? '(The model only reasoned and gave no answer - the token limit may be too low for its thinking.)' : 'Error: No response from AI');
      setTruncated(result.truncated ? (aiSettings.maxTokens || true) : false);
    } catch (err) {
      // Cancel keeps what arrived (or says so); an error goes under what arrived
      const cancelled = !!(err && err.name === 'AbortError');
      const note = cancelled ? 'Cancelled.' : 'Error: ' + (err && err.message ? err.message : String(err));
      setResponse((prev) => (cancelled ? (prev || note) : (prev ? prev + '\n\n' + note : note)));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPhase(null);
      setLoading(false);
    }
  };
  const handleCancel = () => { abortRef.current?.abort(); };
  const handleContinue = async () => {
    if (loading || !response) return;
    let aiSettings = null;
    try { aiSettings = await resolveAiRequestSettings({ saved: savedAiChatSettings() }); } catch { aiSettings = null; }
    if (!aiSettings) return;
    const question = prompt.trim() ? `${prompt}\n\n${editableSelectedText}` : editableSelectedText;
    await runAsk({ aiSettings, message: `${question}\n\nYour answer so far (cut off at the token limit):\n${response}\n\n${CONTINUE_PROMPT}`, append: true });
  };

  const handleResponseSelection = () => {
    if (!responseRef.current) return;

    const textarea = responseRef.current;
    const selected = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
    setSelectedResponse(selected);
  };

  const handleInsert = (useSelection = false) => {
    const textToInsert = useSelection && selectedResponse ? selectedResponse : response;
    if (textToInsert && onInsert) {
      onInsert(textToInsert);
    }
  };

  const handleDragStart = (e) => {
    setIsDragging(true);
    dragStartRef.current = {
      left: popupPos.x,
      top: popupPos.y,
      x: e.clientX,
      y: e.clientY
    };
  };

  const handleResizeStart = (e) => {
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      width: popupSize.width,
      height: popupSize.height,
      x: e.clientX,
      y: e.clientY
    };
  };

  if (!visible) return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0"
        style={{ zIndex: 2147483646, position: 'fixed', pointerEvents: 'auto' }}
        onClick={onCancel}
      />
      <div
        className="bg-os-card rounded-lg shadow-2xl border border-os-border"
        style={{
          position: 'fixed',
          zIndex: 2147483647,
          left: `${popupPos.x}px`,
          top: `${popupPos.y}px`,
          width: `${popupSize.width}px`,
          height: `${popupSize.height}px`,
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto'
        }}
      >
        {/* Header */}
        <div
          className="px-3 py-2 border-b border-os-border flex items-center justify-between bg-linear-to-r from-purple-50 to-purple-100 cursor-grab active:cursor-grabbing"
          onMouseDown={handleDragStart}
        >
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-purple-600" />
            <span className="text-sm font-semibold text-purple-900">Ask AI About This</span>
          </div>
          <div className="flex items-center gap-1">
            {response && !loading && (
              <button
                onClick={() => {
                  setResponse('');
                  setPrompt('');
                  setSelectedResponse('');
                  setTimeout(() => promptRef.current?.focus(), 0);
                }}
                className="btn btn-brand-ghost p-1"
                title="Clear response"
              >
                <Trash2 size={14} className="text-purple-700" />
              </button>
            )}
            <button
              onClick={onCancel}
              className="btn btn-brand-ghost p-1"
              title="Close"
            >
              <X size={14} className="text-purple-700" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-3 py-3 flex flex-col gap-3 overflow-y-auto flex-1">
          {/* Optional Prompt */}
          <div className="shrink-0">
            <label className="block text-xs text-os-text-primary mb-1">
              Your question or prompt (optional):
            </label>
            <input
              ref={promptRef}
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading && backendStatus === 'online') {
                  e.preventDefault();
                  handleSubmit();
                } else if (e.key === 'Escape') {
                  onCancel();
                }
              }}
              placeholder="e.g., Explain this, Fix this code, Summarize..."
              disabled={loading || backendStatus === 'offline'}
              className="w-full px-2 py-1.5 text-sm border border-purple-300 rounded-sm bg-os-card focus:outline-hidden focus:border-purple-500 focus:ring-1 focus:ring-purple-500 disabled:bg-os-card-secondary disabled:text-os-text-secondary"
            />
          </div>

          {/* Selected Text */}
          <div className="flex-1 flex flex-col min-h-0">
            <label className="block text-xs text-os-text-primary mb-1 shrink-0">
              Selected text (sanitized):
            </label>
            <textarea
              value={editableSelectedText}
              onChange={(e) => setEditableSelectedText(e.target.value)}
              disabled={loading}
              className="w-full h-full px-2 py-2 border border-os-border rounded-sm bg-os-card-secondary font-mono text-xs resize-none focus:outline-hidden focus:border-purple-500 disabled:opacity-75"
            />
          </div>

          {/* Response */}
          {(response || loading) && (
            <div className="flex-1 flex flex-col min-h-0">
              <label className="block text-xs text-os-text-primary mb-1 shrink-0 flex items-center justify-between gap-2">
                <span>{loading ? (phase === 'thinking' ? 'The model is thinking...' : phase === 'answering' ? 'Answering...' : 'Waiting for the model...') : 'Response:'}</span>
                {loading && <button type="button" onClick={handleCancel} className="btn btn-secondary px-2 py-0.5 text-xs" data-testid="ask-ai-cancel">Cancel</button>}
              </label>
              <div className="relative flex-1">
                <textarea
                  ref={responseRef}
                  value={loading && !response ? (phase === 'thinking' ? 'Thinking...' : 'Waiting for the model...') : response}
                  readOnly={loading}
                  onSelect={handleResponseSelection}
                  onMouseUp={handleResponseSelection}
                  className="w-full h-full px-2 py-2 border border-os-border rounded-sm bg-os-card-secondary font-mono text-xs resize-none focus:outline-hidden cursor-text"
                />
                {loading && !response && (
                  <div className="absolute inset-0 flex items-center justify-center bg-os-card/75 rounded-sm">
                    <RefreshCw size={20} className="text-purple-600 animate-spin" />
                  </div>
                )}
              </div>
              {truncated && !loading && (
                <p className="text-xs text-os-text-secondary mt-1 flex items-center justify-between gap-2 shrink-0" data-testid="ask-ai-truncated">
                  <span>{truncationMessage(typeof truncated === 'number' ? truncated : null)}</span>
                  <button type="button" onClick={handleContinue} className="btn btn-secondary px-2 py-0.5 text-xs shrink-0" data-testid="ask-ai-continue">Continue</button>
                </p>
              )}
              {selectedResponse && !loading && (
                <p className="text-xs text-purple-600 mt-1 shrink-0">
                  {selectedResponse.length} characters selected
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-os-border flex justify-end gap-2 bg-os-card-secondary">
          {!response ? (
            <button
              onClick={handleSubmit}
              disabled={!editableSelectedText.trim() || loading || backendStatus === 'offline'}
              className="btn btn-brand flex-1 px-3 py-1.5 text-xs flex items-center justify-center gap-1.5"
              title={backendStatus === 'offline' ? 'Backend service is not running' : 'Ask AI (Enter)'}
            >
              {loading ? 'Asking...' : 'Ask AI'}
            </button>
          ) : (
            !loading && (
              <button
                onClick={() => handleInsert(true)}
                disabled={!selectedResponse}
                className="btn btn-success flex-1 px-3 py-1.5 text-xs flex items-center justify-center gap-1.5"
                title={selectedResponse ? 'Insert selected text' : 'Select text in the response to insert'}
              >
                <Check size={14} />
                Insert Selected
              </button>
            )
          )}
        </div>

        {/* Resize Handle */}
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-10"
          onMouseDown={handleResizeStart}
          style={{
            background: 'linear-gradient(135deg, transparent 50%, #9333ea 50%)',
            borderBottomRightRadius: '0.5rem'
          }}
        />
      </div>
    </>,
    document.body
  );
}
