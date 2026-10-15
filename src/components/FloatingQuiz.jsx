import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Minus, Users } from 'lucide-react';
import { getMachineId } from '../utils/cloudCentralSync';
import { onConnectionStatusChange } from '../utils/cloudWebSocket';
import { GAME_MODES, getGameModeComponent } from '../utils/gameModeRegistry';
import ModeSelector from './game-shared/ModeSelector';

/**
 * FloatingQuiz - Floating window shell for game modes
 *
 * This is a thin orchestrator that manages:
 * - Window chrome (header, drag, minimize, close)
 * - Window position and state
 * - Mode selection routing
 * - Portal rendering
 *
 * All game logic lives in individual game mode components:
 * - QuizGameMode.jsx
 * - GridGameMode.jsx
 * - TilesGameMode.jsx
 */
export default function FloatingQuiz() {
  // Window state
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [width] = useState(700);
  const [height] = useState(600);
  const [position, setPosition] = useState(() => {
    const saved = localStorage.getItem('floatingQuizPosition');
    return saved ? JSON.parse(saved) : { top: 100, left: window.innerWidth / 2 - 350 };
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ top: 0, left: 0, x: 0, y: 0 });
  const windowRef = useRef(null);

  // Game mode selection
  const [selectedMode, setSelectedMode] = useState(null);
  const [pendingChallenge, setPendingChallenge] = useState(null);

  // User identification
  const [currentMachineId, setCurrentMachineId] = useState(null);
  const [isCentralServerConnected, setIsCentralServerConnected] = useState(false);

  // Initialize machine ID
  useEffect(() => {
    async function initMachineId() {
      const id = await getMachineId();
      setCurrentMachineId(id);
    }
    initMachineId();
  }, []);

  // Connection status listener
  useEffect(() => {
    const unsub = onConnectionStatusChange((status) => {
      setIsCentralServerConnected(status.connected);
    });
    return unsub;
  }, []);

  // Listen for quiz challenge acceptances
  useEffect(() => {
    const handleChallengeAccepted = (event) => {
      const { gameId: acceptedGameId, opponentId, opponentName } = event.detail;

      console.log('[FloatingQuiz] Challenge accepted, opening window and selecting mode:', acceptedGameId);

      // Store the challenge details to pass to the game mode
      setPendingChallenge({
        gameId: acceptedGameId,
        opponentId,
        opponentName
      });

      // Open quiz window
      setIsOpen(true);
      setIsMinimized(false);

      // Determine which game mode based on gameId prefix
      if (acceptedGameId.startsWith('grid-')) {
        setSelectedMode('grid');
      } else if (acceptedGameId.startsWith('tiles-')) {
        setSelectedMode('tiles');
      } else {
        setSelectedMode('quiz');
      }
    };

    window.addEventListener('quizChallengeAccepted', handleChallengeAccepted);
    return () => window.removeEventListener('quizChallengeAccepted', handleChallengeAccepted);
  }, []);

  // Validate and save position to localStorage
  useEffect(() => {
    if (!isDragging) {
      // Ensure window is within viewport bounds
      const validatedPosition = {
        top: Math.max(0, Math.min(position.top, window.innerHeight - 100)), // Keep at least 100px visible
        left: Math.max(0, Math.min(position.left, window.innerWidth - 100))
      };

      // Only update if position changed
      if (validatedPosition.top !== position.top || validatedPosition.left !== position.left) {
        // Intentional external-system sync in an effect; the setState here is
        // the subscription/measurement result, not derived render state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPosition(validatedPosition);
      }

      localStorage.setItem('floatingQuizPosition', JSON.stringify(validatedPosition));
    }
  }, [position, isDragging]);

  // Check if saved position is off-screen on mount/resize and reset if needed
  useEffect(() => {
    const validatePosition = () => {
      const savedPos = localStorage.getItem('floatingQuizPosition');
      if (savedPos) {
        const pos = JSON.parse(savedPos);
        const isOffScreen =
          pos.top < -height + 100 ||
          pos.top > window.innerHeight - 100 ||
          pos.left < -width + 100 ||
          pos.left > window.innerWidth - 100;

        if (isOffScreen) {
          // Reset to center
          const centered = {
            top: Math.max(100, (window.innerHeight - height) / 2),
            left: Math.max(100, (window.innerWidth - width) / 2)
          };
          setPosition(centered);
          localStorage.setItem('floatingQuizPosition', JSON.stringify(centered));
        }
      }
    };

    validatePosition();
    window.addEventListener('resize', validatePosition);
    return () => window.removeEventListener('resize', validatePosition);
  }, [width, height]);

  // Expose open method globally and listen for toggle event
  useEffect(() => {
    window.openFloatingQuiz = () => setIsOpen(true);

    const handleToggleQuiz = () => {
      setIsOpen(prev => !prev);
    };

    window.addEventListener('toggleQuiz', handleToggleQuiz);

    return () => {
      delete window.openFloatingQuiz;
      window.removeEventListener('toggleQuiz', handleToggleQuiz);
    };
  }, []);

  // Dispatch state change events for sidebar
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('quizStateChange', {
      detail: { isOpen }
    }));
  }, [isOpen]);

  // Dragging handlers
  const handleDragStart = (e) => {
    if (e.target.closest('.drag-handle')) {
      setIsDragging(true);
      dragStartRef.current = {
        top: position.top,
        left: position.left,
        x: e.clientX,
        y: e.clientY,
      };
    }
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      // Calculate new position
      let newTop = dragStartRef.current.top + deltaY;
      let newLeft = dragStartRef.current.left + deltaX;

      // Constrain to viewport bounds (keep at least 100px visible on each side)
      newTop = Math.max(-height + 100, Math.min(newTop, window.innerHeight - 100));
      newLeft = Math.max(-width + 100, Math.min(newLeft, window.innerWidth - 100));

      setPosition({
        top: newTop,
        left: newLeft,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, width, height]);

  // Handle window close
  const handleClose = () => {
    // Dispatch close event so game modes can clean up
    window.dispatchEvent(new CustomEvent('floatingQuizClosing'));

    setIsOpen(false);
    setSelectedMode(null);
    setPendingChallenge(null);
  };

  // Handle back to mode selection
  const handleBackToModeSelect = () => {
    setSelectedMode(null);
    setPendingChallenge(null);
  };

  // Don't render if not open
  if (!isOpen) return null;

  // Get mode title for header
  const getModeTitle = () => {
    const mode = GAME_MODES.find(m => m.id === selectedMode);
    return mode ? mode.name : 'Games';
  };

  // Minimized state - show collapsed bar
  if (isMinimized) {
    return createPortal(
      <div
        className="fixed bg-os-card border border-os-border rounded-sm shadow-lg flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing drag-handle select-none"
        style={{
          top: `${position.top}px`,
          left: `${position.left}px`,
          zIndex: 2147483647
        }}
        onMouseDown={handleDragStart}
      >
        <Users size={14} className="text-os-blue" />
        <span className="text-xs font-medium text-os-text-primary">
          {getModeTitle()}
        </span>
        <div className="flex items-center gap-0.5 ml-auto">
          <button
            onClick={() => setIsMinimized(false)}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors text-os-text-secondary"
            title="Expand"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors text-os-text-secondary"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>,
      document.body
    );
  }

  // Get the selected game mode component
  // getGameModeComponent returns stable module-level component references
  // from the registry, so no component is actually created during render.
  const GameModeComponent = selectedMode ? getGameModeComponent(selectedMode) : null;

  // Full window state
  return createPortal(
    <div
      ref={windowRef}
      className="fixed bg-os-card border border-os-border rounded-sm shadow-2xl flex flex-col select-none"
      style={{
        width: `${width}px`,
        height: `${height}px`,
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 2147483647
      }}
    >
      {/* Header */}
      <div
        className="px-3 py-2 border-b border-os-border flex items-center justify-between bg-os-card-secondary cursor-grab active:cursor-grabbing drag-handle"
        onMouseDown={handleDragStart}
      >
        <div className="flex items-center gap-2">
          <Users size={14} className="text-os-blue" />
          <span className="text-xs font-semibold text-os-text-primary">
            {getModeTitle()}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setIsMinimized(true)}
            className="p-1 hover:bg-os-card rounded-sm transition-colors text-os-text-secondary"
            title="Minimize"
          >
            <Minus size={12} />
          </button>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-os-card rounded-sm transition-colors text-os-text-secondary"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedMode ? (
          <ModeSelector onSelectMode={setSelectedMode} />
        ) : GameModeComponent && currentMachineId ? (
          /* eslint-disable-next-line react-hooks/static-components -- GameModeComponent is a stable module-level component from the registry, not created during render */
          <GameModeComponent
            onBack={handleBackToModeSelect}
            currentMachineId={currentMachineId}
            isCentralServerConnected={isCentralServerConnected}
            pendingChallenge={pendingChallenge}
            onChallengeHandled={() => setPendingChallenge(null)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-os-text-secondary">Loading...</p>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
