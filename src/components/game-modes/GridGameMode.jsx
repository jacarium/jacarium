import { useState, useEffect, useRef } from 'react';
import { Clock, Globe, HelpCircle, Sparkles, FileCode, GitBranch, Package, Network, Code, Server, Play, X, Save, FolderOpen, Trash2, Download, Upload } from 'lucide-react';
import {
  GAME_STATES,
  GRID_POINT_VALUES,
  GRID_ANSWER_TIME,
  GRID_BUZZ_WINDOW,
  GRID_GAME_TIME,
  TYPING_SPEED_MS,
  TYPING_DELAY_MS
} from '../../constants/gameConstants';
import { useGridEventListeners } from '../../hooks/useGridEventListeners';
import {
  sendGridJoin,
  sendGridStart,
  sendGridSelectTile,
  sendGridBuzz,
  sendGridAnswer,
  sendGridEnd,
  sendGridRequestSync,
  sendGridLeave,
  sendGridSyncPlayers,
  sendLobbyNameUpdate,
  sendLobbyMetadataUpdate,
  onLobbyNameUpdate,
  fetchAvailableGames
} from '../../utils/cloudWebSocket';
import { fuzzyMatchAnswer } from '../../utils/answerMatching';
import { generateCategoryFromTopic, generateCategoryFromURL, generateCategoryFromFile } from '../../utils/aiGridGenerator';
import { getQuestionsForCategory } from '../../data/gridQuestions';
import { getAllCustomGrids, addCustomGrid, deleteCustomGrid } from '../../utils/customContentDB';
import { getCentralServerUrl } from '../../utils/cloudCentralSync';
import { notifyCentralUnavailable } from '../../utils/centralAvailability';
import { useDisplayName } from '../../hooks/useDisplayName';
import GameBrowser from '../game-shared/GameBrowser';
import GameLobby from '../game-shared/GameLobby';
import GameResults from '../game-shared/GameResults';
import InviteModal from '../game-shared/InviteModal';
import ShareLinkModal from '../game-shared/ShareLinkModal';
import ConfirmationModal from '../common/modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import { useNotifications } from '../../contexts/NotificationContext';

// Available quiz types for Grid categories (standard topics only)
const QUIZ_TYPES = [
  { id: 'linux-basics', title: 'Linux Basics', icon: FileCode, color: 'blue' },
  { id: 'docker', title: 'Docker', icon: Package, color: 'cyan' },
  { id: 'git', title: 'Git', icon: GitBranch, color: 'orange' },
  { id: 'networking', title: 'Networking', icon: Network, color: 'green' },
  { id: 'python', title: 'Python', icon: Code, color: 'yellow' },
  { id: 'kubernetes', title: 'Kubernetes', icon: Server, color: 'indigo' },
];

/**
 * GridGameMode - Complete Grid game mode implementation
 * 6×5 Jeopardy-style game board with categories and point values
 *
 * @param {Object} props
 * @param {Function} props.onBack - Callback to return to mode selection
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {boolean} props.isCentralServerConnected - Connection status
 * @param {Object} props.pendingChallenge - Challenge details if joining via invite
 * @param {Function} props.onChallengeHandled - Callback when challenge has been handled
 */
export default function GridGameMode({ onBack, currentMachineId, isCentralServerConnected, pendingChallenge, onChallengeHandled }) {
  // Our player name: the OS username on the desktop, the name chosen in
  // Settings in a browser (useDisplayName), the id's user part until known
  const currentDisplayName = useDisplayName(currentMachineId);
  const selfName = () => currentDisplayName || String(currentMachineId || '').split('@')[0];
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();
  // Game session state
  const [gameState, setGameState] = useState(GAME_STATES.GAME_BROWSER);
  const [gameId, setGameId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState(null);
  const [isSinglePlayer, setIsSinglePlayer] = useState(false);
  const [players, setPlayers] = useState([]);
  const [lobbyName, setLobbyName] = useState('');
  const [scoreHistory, setScoreHistory] = useState({});
  const [myAnswer, setMyAnswer] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showShareLinkModal, setShowShareLinkModal] = useState(false);
  const [availableGames, setAvailableGames] = useState([]);

  // AI generation state
  const [aiGridMode, setAiGridMode] = useState('standard'); // 'standard', 'ai-generated', 'custom'
  const [aiGridCategories, setAiGridCategories] = useState([
    { name: '', inputMode: 'topic', topicName: '', url: '', urlTopic: '', file: null, fileTopic: '' },
    { name: '', inputMode: 'topic', topicName: '', url: '', urlTopic: '', file: null, fileTopic: '' },
    { name: '', inputMode: 'topic', topicName: '', url: '', urlTopic: '', file: null, fileTopic: '' },
    { name: '', inputMode: 'topic', topicName: '', url: '', urlTopic: '', file: null, fileTopic: '' },
    { name: '', inputMode: 'topic', topicName: '', url: '', urlTopic: '', file: null, fileTopic: '' },
    { name: '', inputMode: 'topic', topicName: '', url: '', urlTopic: '', file: null, fileTopic: '' }
  ]);
  const [aiDifficultyYears, setAiDifficultyYears] = useState(5);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [aiGeneratedBoard, setAiGeneratedBoard] = useState(null);

  // Custom grids state
  const [customGrids, setCustomGrids] = useState([]);
  const [loadingCustomGrids, setLoadingCustomGrids] = useState(false);
  const [showSaveGridModal, setShowSaveGridModal] = useState(false);
  const [saveGridName, setSaveGridName] = useState('');

  const playersRef = useRef(players);
  useEffect(() => { playersRef.current = players; }, [players]);

  // Grid-specific state
  const [gridState, setGridState] = useState({
    board: [],
    currentTile: null,
    currentBuzzer: null,
    buzzerWindow: false,
    timeRemaining: GRID_BUZZ_WINDOW,
    attemptedPlayers: [],
    selector: null,
    showingAnswer: false,
    lastCorrectAnswerer: undefined,
    answeredTiles: [],
    selectedCategories: QUIZ_TYPES.slice(0, 6).map(qt => qt.id),
    gameTimeRemaining: GRID_GAME_TIME,
    typingInProgress: false,
    typingStartTime: null,
    typingDuration: 0,
    typingPausedAt: null,
    serverTime: null,
    incorrectAnswers: []
  });

  const [typedQuestion, setTypedQuestion] = useState('');
  const [clockOffset, setClockOffset] = useState(0); // Server time - client time
  const typingIntervalRef = useRef(null);
  const gameTimerRef = useRef(null);
  const questionTimerRef = useRef(null);
  const [localGameTime, setLocalGameTime] = useState(null);
  const [localQuestionTime, setLocalQuestionTime] = useState(null);

  // Event listeners for multiplayer
  useGridEventListeners({
    gameId,
    isHost,
    currentMachineId,
    gameState,
    players,
    gridState,
    playersRef,
    setPlayers,
    setGameState,
    setGridState,
    setScoreHistory,
    setMyAnswer,
    sendGridSyncPlayers
  });

  // Lobby name listener
  useEffect(() => {
    if (!gameId) return;
    const unsub = onLobbyNameUpdate((data) => {
      if (data.gameId === gameId) setLobbyName(data.lobbyName);
    });
    return unsub;
  }, [gameId]);

  // Auto-refresh available games when in game browser
  useEffect(() => {
    if (gameState !== GAME_STATES.GAME_BROWSER || !currentMachineId || !isCentralServerConnected) return;

    const refreshGames = async () => {
      try {
        const games = await fetchAvailableGames(currentMachineId);
        setAvailableGames(games);
      } catch (error) {
        console.error('[GridGameMode] Failed to fetch available games:', error);
      }
    };

    refreshGames();
    const interval = setInterval(refreshGames, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, [gameState, currentMachineId, isCentralServerConnected]);

  // Handle FloatingQuiz window closing
  useEffect(() => {
    const handleWindowClosing = () => {
      // Notify server we're leaving the game (only for multiplayer in lobby or playing)
      if (gameId && currentMachineId && !isSinglePlayer && (gameState === GAME_STATES.LOBBY || gameState === GAME_STATES.GRID_BOARD || gameState === GAME_STATES.GRID_QUESTION)) {
        console.log('[GridGameMode] Window closing, notifying server of disconnect');
        sendGridLeave(gameId, currentMachineId).catch(err =>
          console.error('[GridGameMode] Failed to notify server of exit:', err)
        );
      }
    };

    window.addEventListener('floatingQuizClosing', handleWindowClosing);
    return () => window.removeEventListener('floatingQuizClosing', handleWindowClosing);
  }, [gameId, currentMachineId, isSinglePlayer, gameState]);

  // Handle pending challenge (when someone accepts an invite)
  useEffect(() => {
    if (!pendingChallenge || !currentMachineId) return;

    const { gameId: acceptedGameId } = pendingChallenge;

    // Only handle if it's a grid game
    if (!acceptedGameId.startsWith('grid-')) {
      return;
    }

    console.log('[GridGameMode] Handling pending challenge, joining game:', acceptedGameId);

    const playerName = selfName();

    // Send join event first - server will send player sync
    (async () => {
      try {
        await sendGridJoin(acceptedGameId, currentMachineId, playerName);
        console.log('[GridGameMode] Joined game:', acceptedGameId);

        // After successful join, set game state
        // Don't set players - let the server sync handle it
        setGameId(acceptedGameId);
        setIsHost(false);
        setGameState(GAME_STATES.LOBBY);
        setIsSinglePlayer(false);

        // Request player sync for Grid
        setTimeout(() => {
          sendGridRequestSync(acceptedGameId, currentMachineId);
          console.log('[GridGameMode] Requested player sync');
        }, 200);

        // Mark challenge as handled
        if (onChallengeHandled) {
          onChallengeHandled();
        }
      } catch (error) {
        console.error('[GridGameMode] Failed to join game:', error);
      }
    })();
    // selfName is read once, when the accepted challenge is joined; it is a plain function remade on every
    // render and changes with the display name, and a name change must not join the game again
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selfName: read at join time only (see above)
  }, [pendingChallenge, currentMachineId, onChallengeHandled]);

  // Update clock offset when we receive server time
  useEffect(() => {
    if (gridState.serverTime) {
      const clientTime = Date.now();
      const offset = gridState.serverTime - clientTime;
      // Intentional sync with the server clock
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClockOffset(offset);
      console.log('[Typewriter] Clock offset updated:', offset, 'ms');
    }
  }, [gridState.serverTime]);

  // Typewriter effect - client-side animation synchronized with server clock
  useEffect(() => {
    // Clear any existing interval
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }

    if (!gridState.currentTile) {
      // Intentional reset of the typewriter animation state
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTypedQuestion('');
      return;
    }

    const questionText = gridState.currentTile.question?.question || '';

    // If paused, show up to pause point
    if (gridState.typingPausedAt !== null && !gridState.typingInProgress) {
      setTypedQuestion(questionText.substring(0, gridState.typingPausedAt));
      return;
    }

    // If not typing, show full question
    if (!gridState.typingInProgress) {
      setTypedQuestion(questionText);
      return;
    }

    // Typing in progress - use synchronized time
    const typingStartTime = gridState.typingStartTime;
    if (!typingStartTime) return;

    const updateTyping = () => {
      const clientTime = Date.now();
      const syncedTime = clientTime + clockOffset; // Sync with server clock
      const elapsed = syncedTime - typingStartTime;

      if (elapsed < 0) {
        // Still in delay
        setTypedQuestion('');
        return false;
      }

      const charIndex = Math.floor(elapsed / 50); // 50ms per character
      if (charIndex >= questionText.length) {
        setTypedQuestion(questionText);
        return true; // Done
      }

      setTypedQuestion(questionText.substring(0, charIndex + 1));
      return false;
    };

    // Initial update
    if (!updateTyping()) {
      // Continue with interval
      typingIntervalRef.current = setInterval(() => {
        if (updateTyping()) {
          clearInterval(typingIntervalRef.current);
          typingIntervalRef.current = null;
        }
      }, 50);
    }

    return () => {
      if (typingIntervalRef.current) {
        clearInterval(typingIntervalRef.current);
        typingIntervalRef.current = null;
      }
    };
  }, [gridState.currentTile, gridState.typingInProgress, gridState.typingStartTime, gridState.typingPausedAt, clockOffset]);

  // Game timer (5 minutes) - smooth synchronized countdown
  useEffect(() => {
    if (gameTimerRef.current) {
      clearInterval(gameTimerRef.current);
      gameTimerRef.current = null;
    }

    if (gameState !== GAME_STATES.GRID_BOARD && gameState !== GAME_STATES.GRID_QUESTION) {
      // Intentional sync of the smooth display timer with authoritative state
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalGameTime(null);
      return;
    }

    // For multiplayer, use server's authoritative time
    if (!isSinglePlayer) {
      setLocalGameTime(gridState.gameTimeRemaining);
      return;
    }

    // For single player, run local countdown
    const updateGameTimer = () => {
      setGridState(prev => {
        const newTime = prev.gameTimeRemaining - 1;
        if (newTime <= 0) {
          setGameState(GAME_STATES.RESULTS);
          return { ...prev, gameTimeRemaining: 0 };
        }
        setLocalGameTime(newTime);
        return { ...prev, gameTimeRemaining: newTime };
      });
    };

    gameTimerRef.current = setInterval(updateGameTimer, 1000);

    return () => {
      if (gameTimerRef.current) {
        clearInterval(gameTimerRef.current);
        gameTimerRef.current = null;
      }
    };
    // gridState.gameTimeRemaining is deliberately excluded: including it
    // would re-arm the 1s interval on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, isSinglePlayer]);

  // Smooth display update for multiplayer game timer
  useEffect(() => {
    if (isSinglePlayer || !gridState.gameTimeRemaining) return;
    // Intentional sync with the server's authoritative countdown
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalGameTime(gridState.gameTimeRemaining);
  }, [gridState.gameTimeRemaining, isSinglePlayer]);

  // Question timer - smooth synchronized countdown
  useEffect(() => {
    if (questionTimerRef.current) {
      clearInterval(questionTimerRef.current);
      questionTimerRef.current = null;
    }

    if (gameState !== GAME_STATES.GRID_QUESTION || !gridState.currentTile || gridState.showingAnswer) {
      // Intentional sync of the smooth display timer with authoritative state
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalQuestionTime(null);
      return;
    }

    // For multiplayer, use server's authoritative time
    if (!isSinglePlayer) {
      setLocalQuestionTime(gridState.timeRemaining);
      return;
    }

    // For single player, run local countdown
    const updateQuestionTimer = () => {
      setGridState(prev => {
        const newTime = prev.timeRemaining - 1;

        if (newTime <= 0) {
          // Buzz window expired - show answer if nobody buzzed
          if (prev.buzzerWindow && !prev.currentBuzzer) {
            console.log('[Grid] Buzz window expired, showing answer');
            const updatedBoard = prev.board.map(tile =>
              tile.categoryId === prev.currentTile.categoryId &&
              tile.difficulty === prev.currentTile.difficulty
                ? { ...tile, answered: true }
                : tile
            );

            setTimeout(() => {
              setGameState(GAME_STATES.GRID_BOARD);
              setGridState(p => ({ ...p, currentTile: null, showingAnswer: false }));
            }, 3000);

            setLocalQuestionTime(0);
            return {
              ...prev,
              timeRemaining: 0,
              buzzerWindow: false,
              showingAnswer: true,
              lastCorrectAnswerer: null,
              board: updatedBoard
            };
          }

          // Answer time expired - someone had buzzed
          if (prev.currentBuzzer) {
            setGridState(p => ({
              ...p,
              showingAnswer: true,
              lastCorrectAnswerer: null,
              board: p.board.map(tile =>
                tile.categoryId === p.currentTile.categoryId &&
                tile.difficulty === p.currentTile.difficulty
                  ? { ...tile, answered: true }
                  : tile
              )
            }));
            setTimeout(() => {
              setGameState(GAME_STATES.GRID_BOARD);
              setGridState(p => ({ ...p, currentTile: null, showingAnswer: false }));
            }, 3000);
            setLocalQuestionTime(0);
            return { ...prev, timeRemaining: 0 };
          }

          setLocalQuestionTime(0);
          return { ...prev, timeRemaining: 0 };
        }

        setLocalQuestionTime(newTime);
        return { ...prev, timeRemaining: newTime };
      });
    };

    questionTimerRef.current = setInterval(updateQuestionTimer, 1000);

    return () => {
      if (questionTimerRef.current) {
        clearInterval(questionTimerRef.current);
        questionTimerRef.current = null;
      }
    };
    // gridState.timeRemaining is deliberately excluded: including it would
    // re-arm the 1s interval on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, gridState.currentTile, gridState.showingAnswer, isSinglePlayer]);

  // Smooth display update for multiplayer question timer
  useEffect(() => {
    if (isSinglePlayer || !gridState.timeRemaining) return;
    // Intentional sync with the server's authoritative countdown
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalQuestionTime(gridState.timeRemaining);
  }, [gridState.timeRemaining, isSinglePlayer]);

  // Check if all tiles are answered
  useEffect(() => {
    if (gameState !== GAME_STATES.GRID_BOARD) return;

    const allAnswered = gridState.board.length > 0 && gridState.board.every(tile => tile.answered);
    if (allAnswered) {
      console.log('[Grid] All tiles answered - ending game');
      setTimeout(() => {
        setGameState(GAME_STATES.RESULTS);

        if (isHost && !isSinglePlayer) {
          const finalScores = players.map(p => ({ id: p.id, name: p.name, score: p.score }));
          sendGridEnd(gameId, finalScores).catch(err =>
            console.error('[Grid] Failed to broadcast game end:', err)
          );
        }
      }, 1000);
    }
  }, [gameState, gridState.board, isHost, players, isSinglePlayer, gameId]);

  // Quit an in-progress game via the X button (back to mode selection).
  // Must tell the server we're leaving: unlike closing the floating window
  // (which fires 'floatingQuizClosing'), unmounting this component fires no
  // event, and the app's shared socket stays connected - so without an
  // explicit grid-leave the server would keep this player marked connected
  // and the abandoned game listed under "Running Games" forever.
  function quitToModeSelect() {
    if (gameId && currentMachineId && !isSinglePlayer) {
      sendGridLeave(gameId, currentMachineId).catch(err =>
        console.error('[GridGameMode] Failed to notify server when quitting:', err)
      );
    }
    onBack();
  }

  // Handlers
  async function loadCustomGrids() {
    try {
      setLoadingCustomGrids(true);
      const grids = await getAllCustomGrids();
      setCustomGrids(grids);
      console.log('[Grid] Loaded', grids.length, 'custom grids');
    } catch (error) {
      console.error('[Grid] Failed to load custom grids:', error);
    } finally {
      setLoadingCustomGrids(false);
    }
  }

  async function generateAIGrid() {
    try {
      setIsGenerating(true);
      const allQuestions = [];

      // Generate questions for each category
      for (let i = 0; i < aiGridCategories.length; i++) {
        const category = aiGridCategories[i];
        if (!category.name.trim()) {
          setGenerationStatus(`Category ${i + 1} needs a name`);
          continue;
        }

        setGenerationStatus(`Generating ${category.name} (${i + 1}/6)...`);

        try {
          let categoryQuestions;

          // Generate based on input mode
          if (category.inputMode === 'topic') {
            if (!category.topicName.trim()) {
              throw new Error('Topic name required');
            }
            categoryQuestions = await generateCategoryFromTopic({
              categoryName: category.name,
              topicName: category.topicName,
              difficultyYears: aiDifficultyYears
            });
          } else if (category.inputMode === 'url') {
            if (!category.url.trim()) {
              throw new Error('URL required');
            }
            categoryQuestions = await generateCategoryFromURL({
              categoryName: category.name,
              url: category.url,
              urlTopic: category.urlTopic,
              difficultyYears: aiDifficultyYears
            });
          } else if (category.inputMode === 'file') {
            if (!category.file) {
              throw new Error('File required');
            }
            categoryQuestions = await generateCategoryFromFile({
              categoryName: category.name,
              file: category.file,
              fileTopic: category.fileTopic,
              difficultyYears: aiDifficultyYears
            });
          }

          // Add category metadata to each question
          const questionsWithCategory = categoryQuestions.map(q => ({
            ...q,
            categoryId: category.name.toLowerCase().replace(/\s+/g, '-'),
            categoryTitle: category.name
          }));

          allQuestions.push(...questionsWithCategory);
        } catch (error) {
          console.error(`[Grid] Failed to generate ${category.name}:`, error);
          setGenerationStatus(`Error on ${category.name}: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (allQuestions.length === 0) {
        throw new Error('No questions generated');
      }

      // Build the board
      const board = allQuestions.map(q => ({
        categoryId: q.categoryId,
        categoryTitle: q.categoryTitle,
        difficulty: q.points,
        points: q.points,
        question: {
          question: q.question,
          answer: q.answer
        },
        answered: false
      }));

      setAiGeneratedBoard(board);

      // Extract unique category IDs and update selectedCategories
      const categoryIds = [...new Set(board.map(q => q.categoryId))];
      setGridState(prev => ({
        ...prev,
        selectedCategories: categoryIds
      }));

      // If in a lobby, send the board to the server so it can be restored on reconnect
      if (gameId && gameState === GAME_STATES.LOBBY) {
        try {
          await sendLobbyMetadataUpdate(gameId, {
            selectedCategories: categoryIds,
            aiGeneratedBoard: board
          });
          console.log('[Grid] Sent AI-generated board to server for lobby persistence');
        } catch (error) {
          console.error('[Grid] Failed to send AI board to server:', error);
        }
      }

      setGenerationStatus(`Generated ${allQuestions.length} questions!`);
      console.log('[Grid] Generated', allQuestions.length, 'AI questions with categories:', categoryIds);

    } catch (error) {
      console.error('[Grid] AI generation failed:', error);
      setGenerationStatus(`Error: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  }

  function downloadAIGridAsJSON() {
    if (!aiGeneratedBoard || aiGeneratedBoard.length === 0) return;

    const categoryNames = aiGridCategories.map(c => c.name).filter(n => n.trim()).join(', ');
    const gridName = `AI Grid: ${categoryNames.substring(0, 30)}`;

    const customGrid = {
      id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: gridName,
      type: 'ai-generated',
      categories: aiGridCategories.map((cat, idx) => ({
        id: `cat-${idx}`,
        title: cat.name,
        color: ['blue', 'cyan', 'orange', 'green', 'yellow', 'indigo'][idx],
        // Save generation metadata for re-editing
        inputMode: cat.inputMode,
        topicName: cat.topicName,
        url: cat.url,
        urlTopic: cat.urlTopic,
        // Note: file cannot be serialized, user will need to re-upload
        fileTopic: cat.fileTopic
      })),
      board: aiGeneratedBoard,
      difficulty: aiDifficultyYears,
      createdAt: new Date().toISOString()
    };

    const jsonString = JSON.stringify(customGrid, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${gridName.replace(/[^a-z0-9]/gi, '_')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    console.log('[Grid] Downloaded AI grid as JSON:', gridName);
  }

  function showSaveGridDialog() {
    if (!aiGeneratedBoard || aiGeneratedBoard.length === 0) return;
    const categoryNames = aiGridCategories.map(c => c.name).filter(n => n.trim()).join(', ');
    setSaveGridName(`AI Grid: ${categoryNames.substring(0, 30)}`);
    setShowSaveGridModal(true);
  }

  async function saveAIGridAsCustom() {
    if (!saveGridName.trim()) return;

    try {
      const customGrid = {
        id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: saveGridName,
        type: 'ai-generated',
        categories: aiGridCategories.map((cat, idx) => ({
          id: `cat-${idx}`,
          title: cat.name,
          color: ['blue', 'cyan', 'orange', 'green', 'yellow', 'indigo'][idx],
          // Save generation metadata for re-editing
          inputMode: cat.inputMode,
          topicName: cat.topicName,
          url: cat.url,
          urlTopic: cat.urlTopic,
          // Note: file cannot be serialized, user will need to re-upload
          fileTopic: cat.fileTopic
        })),
        board: aiGeneratedBoard,
        difficulty: aiDifficultyYears,
        createdAt: new Date().toISOString()
      };

      await addCustomGrid(customGrid);
      await loadCustomGrids();
      console.log('[Grid] Saved AI grid as custom:', saveGridName);
      setShowSaveGridModal(false);
      setSaveGridName('');

    } catch (error) {
      console.error('[Grid] Failed to save custom grid:', error);
      // Keep modal open to show error
    }
  }

  async function loadCustomGrid(grid) {
    setAiGeneratedBoard(grid.board);
    setAiGridMode('ai-generated');

    // Extract unique category IDs and update selectedCategories
    const categoryIds = [...new Set(grid.board.map(q => q.categoryId))];
    setGridState(prev => ({
      ...prev,
      selectedCategories: categoryIds
    }));

    // If in a lobby, send the board to the server so it can be restored on reconnect
    if (gameId && gameState === GAME_STATES.LOBBY) {
      try {
        await sendLobbyMetadataUpdate(gameId, {
          selectedCategories: categoryIds,
          aiGeneratedBoard: grid.board
        });
        console.log('[Grid] Sent custom board to server for lobby persistence');
      } catch (error) {
        console.error('[Grid] Failed to send custom board to server:', error);
      }
    }

    // Restore generation metadata if available
    if (grid.categories && grid.categories.length > 0) {
      const restoredCategories = grid.categories.map(cat => ({
        name: cat.title || '',
        inputMode: cat.inputMode || 'topic',
        topicName: cat.topicName || '',
        url: cat.url || '',
        urlTopic: cat.urlTopic || '',
        file: null, // Files cannot be restored from JSON
        fileTopic: cat.fileTopic || ''
      }));

      // Pad to 6 categories if needed
      while (restoredCategories.length < 6) {
        restoredCategories.push({
          name: '',
          inputMode: 'topic',
          topicName: '',
          url: '',
          urlTopic: '',
          file: null,
          fileTopic: ''
        });
      }

      setAiGridCategories(restoredCategories);
      console.log('[Grid] Restored category metadata:', restoredCategories);
    }

    // Restore difficulty setting if available
    if (grid.difficulty) {
      setAiDifficultyYears(grid.difficulty);
    }

    console.log('[Grid] Loaded custom grid:', grid.name, 'with categories:', categoryIds);
  }

  async function deleteCustomGridHandler(gridId) {
    if (!(await confirm({
      title: 'Delete Custom Grid',
      message: 'Are you sure you want to delete this custom grid?',
      type: 'danger',
      confirmLabel: 'Delete',
    }))) return;

    try {
      await deleteCustomGrid(gridId);
      await loadCustomGrids();
      console.log('[Grid] Deleted custom grid:', gridId);
    } catch (error) {
      console.error('[Grid] Failed to delete custom grid:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete grid: ' + error.message
      });
    }
  }

  async function importGridFromJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const grid = JSON.parse(text);

        // Validate structure
        if (!grid.board || !Array.isArray(grid.board)) {
          throw new Error('Invalid grid format: missing board array');
        }
        if (!grid.categories || !Array.isArray(grid.categories)) {
          throw new Error('Invalid grid format: missing categories array');
        }

        // Ensure required fields
        const importedGrid = {
          id: grid.id || `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: grid.name || file.name.replace('.json', ''),
          type: grid.type || 'imported',
          categories: grid.categories,
          board: grid.board,
          difficulty: grid.difficulty || 5,
          createdAt: grid.createdAt || new Date().toISOString()
        };

        await addCustomGrid(importedGrid);
        await loadCustomGrids();
        console.log('[Grid] Imported grid:', importedGrid.name);
        addNotification({
          type: 'success',
          title: 'Grid Imported',
          message: `Successfully imported: ${importedGrid.name}`
        });
      } catch (error) {
        console.error('[Grid] Failed to import grid:', error);
        addNotification({
          type: 'error',
          title: 'Import Failed',
          message: 'Failed to import grid: ' + error.message
        });
      }
    };
    input.click();
  }

  async function createLobby() {
    const newGameId = `grid-${Date.now()}`;
    const playerName = selfName();

    setGameId(newGameId);
    setIsHost(true);
    setHostId(currentMachineId);

    const defaultLobbyName = `${playerName}'s Grid`;
    setLobbyName(defaultLobbyName);
    setPlayers([{
      id: currentMachineId,
      name: playerName,
      score: 0,
      ready: true,
      status: 'ready',
      clientType: 'app'
    }]);

    if (isSinglePlayer) {
      // Single player: Start game immediately (no lobby)
      let board = [];

      if (aiGeneratedBoard && aiGeneratedBoard.length > 0) {
        // Use AI-generated board
        board = aiGeneratedBoard;
      } else {
        // Use real questions from database
        console.log('[Grid] Single player - loading questions for categories:', gridState.selectedCategories);

        gridState.selectedCategories.forEach((categoryId) => {
          const categoryQuestions = getQuestionsForCategory(categoryId);
          const categoryTitle = QUIZ_TYPES.find(qt => qt.id === categoryId)?.title || categoryId;

          console.log(`[Grid] Category ${categoryId}: found ${categoryQuestions?.length || 0} questions`);

          // Each category should have 5 questions (100, 200, 300, 400, 500)
          if (categoryQuestions && categoryQuestions.length > 0) {
            categoryQuestions.forEach((q) => {
              if (q && q.question && q.answer && q.points) {
                board.push({
                  categoryId,
                  categoryTitle,
                  difficulty: q.points,
                  points: q.points,
                  question: {
                    question: q.question,
                    answer: q.answer
                  },
                  answered: false
                });
              } else {
                console.warn(`[Grid] Invalid question in category ${categoryId}:`, q);
              }
            });
          } else {
            // Fallback to placeholder if no questions found
            console.warn(`[Grid] No questions found for category: ${categoryId}, using placeholders`);
            GRID_POINT_VALUES.forEach((points, diffIndex) => {
              board.push({
                categoryId,
                categoryTitle,
                difficulty: points,
                points,
                question: {
                  question: `Question ${diffIndex + 1} for ${categoryTitle}`,
                  answer: `Answer ${diffIndex + 1}`
                },
                answered: false
              });
            });
          }
        });

        console.log(`[Grid] Single player - generated board with ${board.length} questions`);
      }

      setGridState(prev => ({
        ...prev,
        board,
        selector: currentMachineId,
        gameTimeRemaining: GRID_GAME_TIME
      }));

      setScoreHistory({ [currentMachineId]: [0] });
      setGameState(GAME_STATES.GRID_BOARD);
    } else {
      // Multiplayer: Create lobby
      setGameState(GAME_STATES.LOBBY);
      try {
        await sendGridJoin(newGameId, currentMachineId, playerName);
        await sendLobbyNameUpdate(newGameId, defaultLobbyName);
        await sendLobbyMetadataUpdate(newGameId, {
          selectedCategories: gridState.selectedCategories
        });
      } catch (error) {
        console.error('[Grid] Failed to create lobby:', error);
      }
    }
  }

  function shareGridLink() {
    if (!gameId) return;

    const centralServerUrl = getCentralServerUrl();

    if (!centralServerUrl) {
      notifyCentralUnavailable(addNotification, 'share a game link');
      return;
    }

    setShowShareLinkModal(true);
  }

  async function startGame() {
    if (!isHost || !gameId) return;

    // Generate board with real questions
    let board = [];

    // Check if we have an AI-generated board (from AI generation or loaded custom grid)
    if (aiGeneratedBoard && aiGeneratedBoard.length > 0) {
      console.log('[Grid] Using AI-generated/custom board with', aiGeneratedBoard.length, 'questions');
      board = aiGeneratedBoard;
    } else {
      // Generate board from standard categories
      if (!gridState.selectedCategories || gridState.selectedCategories.length === 0) {
        console.error('[Grid] No categories selected!');
        return;
      }

      console.log('[Grid] Starting game with categories:', gridState.selectedCategories);

      gridState.selectedCategories.forEach((categoryId) => {
        const categoryQuestions = getQuestionsForCategory(categoryId);
        const categoryTitle = QUIZ_TYPES.find(qt => qt.id === categoryId)?.title || categoryId;

        console.log(`[Grid] Category ${categoryId}: found ${categoryQuestions?.length || 0} questions`);

        // Each category should have 5 questions (100, 200, 300, 400, 500)
        if (categoryQuestions && categoryQuestions.length > 0) {
          categoryQuestions.forEach((q) => {
            if (q && q.question && q.answer && q.points) {
              board.push({
                categoryId,
                categoryTitle,
                difficulty: q.points,
                points: q.points,
                question: {
                  question: q.question,
                  answer: q.answer
                },
                answered: false
              });
            } else {
              console.warn(`[Grid] Invalid question in category ${categoryId}:`, q);
            }
          });
        } else {
          // Fallback to placeholder if no questions found
          console.warn(`[Grid] No questions found for category: ${categoryId}, using placeholders`);
          GRID_POINT_VALUES.forEach((points, diffIndex) => {
            board.push({
              categoryId,
              categoryTitle,
              difficulty: points,
              points,
              question: {
                question: `Question ${diffIndex + 1} for ${categoryTitle}`,
                answer: `Answer ${diffIndex + 1}`
              },
              answered: false
            });
          });
        }
      });

      console.log(`[Grid] Generated board with ${board.length} questions`);
    }

    setGridState(prev => ({
      ...prev,
      board,
      selector: currentMachineId, // Host starts as selector
      gameTimeRemaining: GRID_GAME_TIME
    }));

    setGameState(GAME_STATES.GRID_BOARD);

    if (!isSinglePlayer) {
      try {
        const activePlayers = players.filter(p => p.status !== 'declined');
        await sendGridStart(gameId, board, gridState.selectedCategories, activePlayers);
      } catch (error) {
        console.error('[Grid] Failed to start:', error);
      }
    }
  }

  async function selectGridTile(tile) {
    if (gridState.selector !== currentMachineId) return;

    console.log('[Grid] Tile selected:', tile);

    if (isSinglePlayer) {
      const questionText = tile.question?.question || tile.question || '';
      const typingDurationMs = questionText.length * TYPING_SPEED_MS;

      setGridState(prev => ({
        ...prev,
        currentTile: tile,
        attemptedPlayers: [],
        currentBuzzer: null,
        buzzerWindow: false,
        timeRemaining: 0,
        showingAnswer: false,
        incorrectAnswers: [],
        typingInProgress: true,
        typingStartTime: Date.now() + TYPING_DELAY_MS,
        typingDuration: Math.ceil(typingDurationMs / 1000),
        typingPausedAt: null
      }));
      setMyAnswer('');
      setGameState(GAME_STATES.GRID_QUESTION);
      return;
    }

    try {
      await sendGridSelectTile(gameId, currentMachineId, tile);
    } catch (error) {
      console.error('[Grid] Failed to broadcast tile selection:', error);
    }
  }

  async function buzzIn() {
    if (gameState !== GAME_STATES.GRID_QUESTION) return;
    if (!gridState.typingInProgress && !gridState.buzzerWindow) return;
    if (gridState.attemptedPlayers.includes(currentMachineId)) return;

    console.log('[Grid] Buzz in');

    if (isSinglePlayer) {
      let pauseAt = null;
      if (gridState.typingInProgress && gridState.typingStartTime) {
        // Use synchronized time to match server calculation
        const clientTime = Date.now();
        const syncedTime = clientTime + clockOffset;
        const elapsed = syncedTime - gridState.typingStartTime;
        const charIndex = elapsed < 0 ? 0 : Math.floor(elapsed / 50);
        const questionText = gridState.currentTile?.question?.question || '';
        pauseAt = Math.min(charIndex, questionText.length);
        console.log('[Grid] Buzz-in pause:', { elapsed, charIndex, pauseAt, questionLength: questionText.length });
      }

      setGridState(prev => ({
        ...prev,
        typingInProgress: false,
        typingPausedAt: pauseAt,
        buzzerWindow: false,
        currentBuzzer: currentMachineId,
        timeRemaining: GRID_ANSWER_TIME
      }));
      return;
    }

    sendGridBuzz(gameId, currentMachineId).catch(err =>
      console.error('[Grid] Failed to send buzz:', err)
    );
  }

  async function submitGridAnswer() {
    if (!gridState.currentTile) return;

    const isCorrect = fuzzyMatchAnswer(myAnswer.trim(), gridState.currentTile.question.answer);

    console.log('[Grid] Submitting answer:', { answer: myAnswer.trim(), correct: isCorrect });

    setMyAnswer('');

    if (isSinglePlayer) {
      const pointsEarned = isCorrect ? gridState.currentTile.points : -gridState.currentTile.points;

      setPlayers(prev => prev.map(p =>
        p.id === currentMachineId ? { ...p, score: p.score + pointsEarned } : p
      ));

      setScoreHistory(prevHistory => {
        const currentScore = players[0].score + pointsEarned;
        return {
          [currentMachineId]: [...(prevHistory[currentMachineId] || [0]), currentScore]
        };
      });

      // Both correct and incorrect: mark tile as answered and show answer
      setGridState(prev => {
        const updatedBoard = prev.board.map(tile =>
          tile.categoryId === prev.currentTile.categoryId &&
          tile.difficulty === prev.currentTile.difficulty
            ? { ...tile, answered: true }
            : tile
        );

        return {
          ...prev,
          board: updatedBoard,
          showingAnswer: true,
          lastCorrectAnswerer: isCorrect ? currentMachineId : null,
          currentBuzzer: null,
          buzzerWindow: false,
          typingInProgress: false,
          typingPausedAt: null
        };
      });

      setTimeout(() => {
        setGameState(GAME_STATES.GRID_BOARD);
        setGridState(prev => ({
          ...prev,
          currentTile: null,
          showingAnswer: false
        }));
      }, 3000);

      return;
    }

    try {
      await sendGridAnswer(gameId, currentMachineId, myAnswer.trim(), isCorrect);
    } catch (error) {
      console.error('[Grid] Failed to submit answer:', error);
    }
  }

  // Render functions
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const renderCategorySelection = () => {
    const toggleCategory = (categoryId) => {
      setGridState(prev => {
        const isSelected = prev.selectedCategories.includes(categoryId);
        let newCategories;

        if (isSelected) {
          if (prev.selectedCategories.length <= 6) return prev;
          newCategories = prev.selectedCategories.filter(id => id !== categoryId);
        } else {
          if (prev.selectedCategories.length >= 6) return prev;
          newCategories = [...prev.selectedCategories, categoryId];
        }

        return { ...prev, selectedCategories: newCategories };
      });
    };

    return (
      <div className="flex-1 flex flex-col p-4 overflow-y-auto">
        <div className="mb-4">
          <button onClick={() => setGameState(GAME_STATES.GAME_BROWSER)} className="text-xs text-os-text-secondary hover:text-os-text-primary mb-2">
            ← Back
          </button>
          <h2 className="text-lg font-bold text-os-text-primary">Grid Setup</h2>

          {/* Mode Toggle */}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => {
                setAiGridMode('standard');
                setAiGeneratedBoard(null);
                setGridState(prev => ({ ...prev, board: [], selectedCategories: [] }));
              }}
              className={`px-3 py-1.5 text-xs rounded border ${
                aiGridMode === 'standard'
                  ? 'btn-selected-soft'
                  : 'bg-os-card border-os-border text-os-text-secondary'
              }`}
            >
              Standard
            </button>
            <button
              onClick={() => {
                setAiGridMode('ai-generated');
                setGridState(prev => ({ ...prev, board: [], selectedCategories: [] }));
              }}
              className={`px-3 py-1.5 text-xs rounded border ${
                aiGridMode === 'ai-generated'
                  ? 'btn-brand-soft'
                  : 'bg-os-card border-os-border text-os-text-secondary'
              }`}
            >
              <Sparkles size={12} className="inline mr-1" />
              AI Generated
            </button>
            <button
              onClick={() => {
                setAiGridMode('custom');
                setGridState(prev => ({ ...prev, board: [], selectedCategories: [] }));
                setAiGeneratedBoard(null);
                loadCustomGrids();
              }}
              className={`px-3 py-1.5 text-xs rounded border ${
                aiGridMode === 'custom'
                  ? 'btn-selected-soft'
                  : 'bg-os-card border-os-border text-os-text-secondary'
              }`}
            >
              <FolderOpen size={12} className="inline mr-1" />
              Custom
            </button>
          </div>
        </div>

        {/* Standard Categories */}
        {aiGridMode === 'standard' && (
          <>
            <p className="text-xs text-os-text-secondary mb-3">Choose exactly 6 categories for your grid</p>
            <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-os-text-primary">Categories</span>
            <span className="text-xs text-os-text-secondary">
              {gridState.selectedCategories.length} / 6 selected
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {QUIZ_TYPES.map((quizType) => {
              const Icon = quizType.icon;
              const isSelected = gridState.selectedCategories.includes(quizType.id);
              return (
                <button
                  key={quizType.id}
                  onClick={() => toggleCategory(quizType.id)}
                  className={`px-2 py-2 text-left text-xs border rounded transition-all flex items-center gap-2 ${
                    isSelected
                      ? 'btn btn-selected-soft border-2'
                      : 'bg-os-card border-os-border hover:bg-os-card-secondary'
                  }`}
                >
                  <Icon size={14} className={isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-os-text-secondary'} />
                  <span className={`text-xs ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-os-text-primary'}`}>
                    {quizType.title}
                  </span>
                  {isSelected && <span className="ml-auto text-xs">✓</span>}
                </button>
              );
            })}
          </div>
            </div>
          </>
        )}

        {/* AI Grid Generation UI - 6 Independent Categories */}
        {aiGridMode === 'ai-generated' && (
          <div className="space-y-4">
            {aiGridCategories.map((category, index) => (
              <div key={index} className="bg-os-card-secondary rounded-lg p-4 border border-os-border">
                <h3 className="text-sm font-semibold text-os-text-primary mb-3">
                  Category {index + 1} of 6
                </h3>

                {/* Category Name */}
                <div className="mb-3">
                  <label className="text-xs text-os-text-secondary mb-1 block">Category Name:</label>
                  <input
                    type="text"
                    value={category.name}
                    onChange={(e) => {
                      const updated = [...aiGridCategories];
                      updated[index].name = e.target.value;
                      setAiGridCategories(updated);
                    }}
                    placeholder={`e.g., ${['Basics', 'Advanced', 'Security', 'Performance', 'Deployment', 'Debugging'][index]}`}
                    className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                  />
                </div>

                {/* Input Mode Toggle */}
                <div className="mb-3">
                  <label className="text-xs text-os-text-secondary mb-1 block">Input Mode:</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const updated = [...aiGridCategories];
                        updated[index].inputMode = 'topic';
                        setAiGridCategories(updated);
                      }}
                      className={`px-3 py-1.5 text-xs rounded border ${
                        category.inputMode === 'topic'
                          ? 'btn-brand-soft'
                          : 'bg-os-card border-os-border text-os-text-secondary'
                      }`}
                    >
                      Topic
                    </button>
                    <button
                      onClick={() => {
                        const updated = [...aiGridCategories];
                        updated[index].inputMode = 'url';
                        setAiGridCategories(updated);
                      }}
                      className={`px-3 py-1.5 text-xs rounded border ${
                        category.inputMode === 'url'
                          ? 'btn-brand-soft'
                          : 'bg-os-card border-os-border text-os-text-secondary'
                      }`}
                    >
                      URL
                    </button>
                    <button
                      onClick={() => {
                        const updated = [...aiGridCategories];
                        updated[index].inputMode = 'file';
                        setAiGridCategories(updated);
                      }}
                      className={`px-3 py-1.5 text-xs rounded border ${
                        category.inputMode === 'file'
                          ? 'btn-brand-soft'
                          : 'bg-os-card border-os-border text-os-text-secondary'
                      }`}
                    >
                      File
                    </button>
                  </div>
                </div>

                {/* Topic Mode Input */}
                {category.inputMode === 'topic' && (
                  <div className="mb-3">
                    <label className="text-xs text-os-text-secondary mb-1 block">Topic:</label>
                    <input
                      type="text"
                      value={category.topicName}
                      onChange={(e) => {
                        const updated = [...aiGridCategories];
                        updated[index].topicName = e.target.value;
                        setAiGridCategories(updated);
                      }}
                      placeholder="e.g., Kubernetes Basics"
                      className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                    />
                  </div>
                )}

                {/* URL Mode Input */}
                {category.inputMode === 'url' && (
                  <>
                    <div className="mb-3">
                      <label className="text-xs text-os-text-secondary mb-1 block">Documentation URL:</label>
                      <input
                        type="url"
                        value={category.url}
                        onChange={(e) => {
                          const updated = [...aiGridCategories];
                          updated[index].url = e.target.value;
                          setAiGridCategories(updated);
                        }}
                        placeholder="https://docs.example.com/api"
                        className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                      />
                    </div>
                    <div className="mb-3">
                      <label className="text-xs text-os-text-secondary mb-1 block">Focus Topic (optional):</label>
                      <input
                        type="text"
                        value={category.urlTopic}
                        onChange={(e) => {
                          const updated = [...aiGridCategories];
                          updated[index].urlTopic = e.target.value;
                          setAiGridCategories(updated);
                        }}
                        placeholder="e.g., Authentication"
                        className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                      />
                    </div>
                  </>
                )}

                {/* File Mode Input */}
                {category.inputMode === 'file' && (
                  <>
                    <div className="mb-3">
                      <label className="text-xs text-os-text-secondary mb-1 block">Upload File:</label>
                      <input
                        type="file"
                        accept=".txt,.md,.pdf,.doc,.docx"
                        onChange={(e) => {
                          const updated = [...aiGridCategories];
                          updated[index].file = e.target.files[0] || null;
                          setAiGridCategories(updated);
                        }}
                        className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                      />
                      {category.file && (
                        <p className="text-xs text-os-text-secondary mt-1">{category.file.name}</p>
                      )}
                    </div>
                    <div className="mb-3">
                      <label className="text-xs text-os-text-secondary mb-1 block">Focus Topic (optional):</label>
                      <input
                        type="text"
                        value={category.fileTopic}
                        onChange={(e) => {
                          const updated = [...aiGridCategories];
                          updated[index].fileTopic = e.target.value;
                          setAiGridCategories(updated);
                        }}
                        placeholder="e.g., Chapter 3"
                        className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                      />
                    </div>
                  </>
                )}
              </div>
            ))}

            {/* Difficulty Slider */}
            <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border">
              <label className="text-xs text-os-text-secondary mb-1 block">
                Difficulty: {aiDifficultyYears} {aiDifficultyYears === 1 ? 'year' : 'years'} experience
              </label>
              <input
                type="range"
                min="1"
                max="15"
                value={aiDifficultyYears}
                onChange={(e) => setAiDifficultyYears(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-os-text-muted mt-1">
                <span>Beginner</span>
                <span>Expert</span>
              </div>
            </div>

            {/* Generate Button */}
            <button
              onClick={generateAIGrid}
              disabled={
                isGenerating ||
                !aiGridCategories.every(cat => cat.name.trim()) ||
                !aiGridCategories.every(cat => {
                  if (cat.inputMode === 'topic') return cat.topicName.trim();
                  if (cat.inputMode === 'url') return cat.url.trim();
                  if (cat.inputMode === 'file') return cat.file !== null;
                  return false;
                })
              }
              className="btn btn-brand w-full px-3 py-2 text-sm flex items-center justify-center gap-2"
            >
              <Sparkles size={14} />
              {isGenerating ? 'Generating...' : 'Generate Grid Questions'}
            </button>

            {generationStatus && (
              <p className="text-xs text-os-text-secondary text-center">{generationStatus}</p>
            )}

            {aiGeneratedBoard && (
              <div className="flex gap-2">
                <button
                  onClick={downloadAIGridAsJSON}
                  className="btn btn-primary flex-1 px-3 py-2 text-sm flex items-center justify-center gap-2"
                >
                  <Download size={14} />
                  Download JSON
                </button>
                <button
                  onClick={showSaveGridDialog}
                  className="btn btn-success flex-1 px-3 py-2 text-sm flex items-center justify-center gap-2"
                >
                  <Save size={14} />
                  Save as Custom
                </button>
              </div>
            )}
          </div>
        )}

        {/* Custom Grids UI */}
        {aiGridMode === 'custom' && (
          <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-os-text-primary flex items-center gap-2">
                <FolderOpen size={14} className="text-blue-600" />
                Custom Grids
              </h3>
              <button
                onClick={importGridFromJSON}
                className="btn btn-primary px-2 py-1 text-xs flex items-center gap-1"
              >
                <Upload size={12} />
                Import JSON
              </button>
            </div>

            {loadingCustomGrids ? (
              <p className="text-xs text-os-text-secondary text-center py-4">Loading...</p>
            ) : customGrids.length === 0 ? (
              <p className="text-xs text-os-text-secondary text-center py-4">
                No custom grids saved. Generate an AI grid and save it, or import a JSON file!
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {customGrids.map((grid) => (
                  <div
                    key={grid.id}
                    className="bg-os-card p-3 rounded-sm border border-os-border flex items-center justify-between"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-os-text-primary truncate">
                        {grid.name}
                      </p>
                      <p className="text-xs text-os-text-secondary">
                        {grid.questions?.length || 0} questions • {grid.categories?.length || 0} categories
                      </p>
                      <p className="text-xs text-os-text-muted">
                        {new Date(grid.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex gap-2 ml-2">
                      <button
                        onClick={() => loadCustomGrid(grid)}
                        className="btn btn-primary px-2 py-1 text-xs"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => deleteCustomGridHandler(grid.id)}
                        className="btn btn-danger-solid px-2 py-1 text-xs"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          onClick={createLobby}
          disabled={
            (aiGridMode === 'standard' && gridState.selectedCategories.length !== 6) ||
            (aiGridMode === 'ai-generated' && !aiGeneratedBoard) ||
            (aiGridMode === 'custom' && !aiGeneratedBoard)
          }
          className="btn btn-primary w-full px-3 py-2 text-sm flex items-center justify-center gap-2 mt-4"
        >
          <Play size={16} />
          {isSinglePlayer ? 'Start Grid' : 'Create Lobby'}
        </button>
      </div>
    );
  };

  const renderBoard = () => {
    // Extract categories from the board (like web client does)
    // This works for both standard categories and AI-generated ones
    const uniqueCategoryIds = [...new Set(gridState.board.map(tile => tile.categoryId))];
    const categories = uniqueCategoryIds.map(catId => {
      const tile = gridState.board.find(t => t.categoryId === catId);
      // Try to find in QUIZ_TYPES first (for standard categories), otherwise use tile data
      const standardCategory = QUIZ_TYPES.find(qt => qt.id === catId);
      return {
        id: catId,
        title: standardCategory?.title || tile?.categoryTitle || catId
      };
    });
    const difficulties = GRID_POINT_VALUES;

    return (
      <div className="flex-1 flex flex-col p-4 overflow-hidden">
        {/* Game Timer */}
        <div className="flex justify-between items-center mb-3">
          <div></div>
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1 px-2 py-1 rounded ${
              (localGameTime || gridState.gameTimeRemaining) <= 30 ? 'bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400 animate-pulse' :
              (localGameTime || gridState.gameTimeRemaining) <= 60 ? 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400' :
              'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400'
            }`}>
              <Clock size={14} />
              <span className="text-sm font-bold">{formatTime(localGameTime || gridState.gameTimeRemaining)}</span>
            </div>
            <button
              onClick={quitToModeSelect}
              className="p-1 hover:bg-red-500/10 text-red-600 dark:text-red-400 rounded-sm transition-colors"
              title="Quit Game"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Game Board */}
        <div className="flex-1 flex flex-col gap-2 w-full">
          {/* Category Headers */}
          <div className="grid grid-cols-6 gap-2">
            {categories.map(category => (
              <div key={category.id} className="text-center">
                <span className="text-[11px] font-semibold text-os-text-secondary">{category.title}</span>
              </div>
            ))}
          </div>

          {/* Difficulty Rows */}
          {difficulties.map(difficulty => (
            <div key={difficulty} className="grid grid-cols-6 gap-2 flex-1">
              {categories.map(category => {
                const tile = gridState.board.find(
                  t => t.categoryId === category.id && t.difficulty === difficulty
                );

                if (!tile) {
                  return (
                    <div key={`${category.id}-${difficulty}`} className="h-full flex items-center justify-center bg-os-card border border-os-border rounded-sm opacity-50 text-xs">
                      <span className="text-os-text-muted">-</span>
                    </div>
                  );
                }

                const isAnswered = tile.answered;
                const canSelect = gridState.selector === currentMachineId && !isAnswered;

                return (
                  <button
                    key={`${category.id}-${difficulty}`}
                    onClick={() => canSelect && selectGridTile(tile)}
                    disabled={!canSelect}
                    className={`h-full flex items-center justify-center rounded text-lg font-bold transition-all ${
                      isAnswered
                        ? 'bg-os-card border border-os-border text-os-text-muted opacity-30 cursor-not-allowed'
                        : canSelect
                        ? 'bg-os-card hover:bg-os-card-secondary text-os-text-primary border-2 border-os-border hover:border-os-text-secondary hover:scale-105 cursor-pointer shadow-xs'
                        : 'bg-os-card text-os-text-secondary border border-os-border opacity-60'
                    }`}
                  >
                    {isAnswered ? '✓' : tile.points}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Player Scores */}
        <div className="mt-3 pt-2 border-t border-os-border shrink-0">
          <div className="flex flex-wrap gap-2 justify-center">
            {[...players].sort((a, b) => b.score - a.score).map((player) => {
              const isSelector = player.id === gridState.selector;
              const isMe = player.id === currentMachineId;
              const isDisconnected = player.connected === false;
              return (
                <div
                  key={player.id}
                  className={`flex flex-col items-center px-2 py-1.5 rounded border transition-all ${
                    isDisconnected
                      ? 'bg-os-card-secondary border-os-border opacity-60'
                      : isSelector
                      ? 'bg-blue-50 border-blue-500 dark:bg-blue-950 animate-pulse'
                      : 'bg-os-card-secondary border-os-border'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    {isDisconnected && <Globe size={10} className="text-gray-500" />}
                    <span className="text-xs font-medium text-os-text-primary">{player.name}</span>
                    {isDisconnected && (
                      <span className="text-[10px] bg-gray-500/20 text-gray-400 px-1 py-0.5 rounded-sm">DC</span>
                    )}
                    {isMe && !isDisconnected && (
                      <span className="text-[10px] bg-blue-50 text-blue-600 px-1 py-0.5 rounded-sm dark:bg-blue-950 dark:text-blue-400">You</span>
                    )}
                  </div>
                  <span className="text-sm font-bold text-os-text-secondary">{player.score}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderQuestion = () => {
    if (!gridState.currentTile) return null;

    const question = gridState.currentTile.question;
    const points = gridState.currentTile.points;
    const category = QUIZ_TYPES.find(qt => qt.id === gridState.currentTile.categoryId);
    const Icon = category?.icon || HelpCircle;
    const alreadyBuzzed = gridState.attemptedPlayers.includes(currentMachineId);
    const canBuzz = (gridState.typingInProgress || gridState.buzzerWindow) && !alreadyBuzzed;
    const hasBuzzer = gridState.currentBuzzer !== null;
    const amIBuzzing = gridState.currentBuzzer === currentMachineId;
    const selectorPlayer = players.find(p => p.id === gridState.selector);

    return (
      <div className="flex-1 flex flex-col p-4 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-os-text-muted">{gridState.currentTile.categoryTitle}</span>
            <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-sm font-medium dark:bg-blue-950 dark:text-blue-400">
              {points} pts
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!gridState.typingInProgress && (
              <>
                <div className="flex items-center gap-1.5 text-orange-600">
                  <Clock size={14} />
                  <span className="font-bold text-sm">{localQuestionTime || gridState.timeRemaining}s</span>
                </div>
                <span className="text-xs text-os-text-muted">|</span>
              </>
            )}
            <div className={`flex items-center gap-1 ${
              (localGameTime || gridState.gameTimeRemaining) <= 30 ? 'text-red-600 animate-pulse' :
              (localGameTime || gridState.gameTimeRemaining) <= 60 ? 'text-orange-600' :
              'text-green-600'
            }`}>
              <Clock size={12} />
              <span className="text-xs font-medium">{formatTime(localGameTime || gridState.gameTimeRemaining)}</span>
            </div>
            <button
              onClick={quitToModeSelect}
              className="p-1 hover:bg-red-500/10 text-red-600 dark:text-red-400 rounded-sm transition-colors"
              title="Quit Game"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Selector */}
        {selectorPlayer && (
          <div className="text-center mb-2">
            <p className="text-xs text-os-text-muted">
              Tile selected by <span className="font-medium text-os-text-secondary">{selectorPlayer.name}</span>
            </p>
          </div>
        )}

        {/* Question */}
        <div className="bg-os-card-secondary rounded-sm p-3 mb-3 border border-os-border min-h-12">
          <p className="text-sm font-semibold text-os-text-primary">
            {typedQuestion || ' '}
            {gridState.typingInProgress && (
              <span style={{ animation: 'blink 1s step-end infinite' }}>_</span>
            )}
          </p>
        </div>

        {/* Answer Display */}
        {gridState.showingAnswer && (() => {
          if (gridState.lastCorrectAnswerer && gridState.lastCorrectAnswerer !== 'none') {
            const winner = players.find(p => p.id === gridState.lastCorrectAnswerer);
            return (
              <div className="bg-green-50 border border-green-200 rounded-sm p-3 mb-3 dark:bg-green-950 dark:border-green-800">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-xs font-semibold text-green-800 dark:text-green-300">Correct Answer</h4>
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-sm dark:bg-green-900 dark:text-green-300">
                    {winner?.name}
                  </span>
                </div>
                <p className="text-lg font-bold text-green-900 dark:text-green-200 font-mono">{question.answer}</p>
              </div>
            );
          }
          if (gridState.lastCorrectAnswerer === null) {
            return (
              <div className="bg-red-50 border border-red-200 rounded-sm p-3 mb-3 dark:bg-red-950 dark:border-red-800">
                <h4 className="text-xs font-semibold text-red-800 dark:text-red-300 mb-1">Correct Answer</h4>
                <p className="text-lg font-bold text-red-900 dark:text-red-200 font-mono">{question.answer}</p>
              </div>
            );
          }
          return (
            <div className="bg-blue-50 border border-blue-200 rounded-sm p-3 mb-3 dark:bg-blue-950 dark:border-blue-800">
              <h4 className="text-xs font-semibold text-blue-800 dark:text-blue-300 mb-1">Correct Answer</h4>
              <p className="text-lg font-bold text-blue-900 dark:text-blue-200 font-mono">{question.answer}</p>
            </div>
          );
        })()}

        {/* Buzzer Button */}
        {!hasBuzzer && !gridState.showingAnswer && !alreadyBuzzed && (
          <div className="mb-3">
            <button
              onClick={() => buzzIn()}
              disabled={!canBuzz}
              className="btn btn-danger-solid w-full px-4 py-3 text-sm font-bold shadow-md hover:shadow-lg"
            >
              {canBuzz ? 'Buzz In' : 'Waiting for Buzz Window...'}
            </button>

            {gridState.incorrectAnswers && gridState.incorrectAnswers.length > 0 && (
              <div className="mt-3 space-y-2">
                {gridState.incorrectAnswers.map((ia, idx) => (
                  <div key={idx} className="bg-red-50 border border-red-200 rounded-sm p-2 dark:bg-red-950 dark:border-red-800">
                    <div className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1">
                      {ia.playerName} guessed:
                    </div>
                    <div className="text-sm text-red-600 dark:text-red-300 font-mono">
                      {ia.answer}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Already attempted */}
        {!hasBuzzer && !gridState.showingAnswer && alreadyBuzzed && (
          <div className="mb-3 bg-os-card-secondary border border-os-border rounded-sm p-3 text-center">
            <p className="text-xs text-os-text-muted">You already attempted. Waiting for other players...</p>
          </div>
        )}

        {/* Answer Input */}
        {hasBuzzer && !gridState.showingAnswer && (
          <div className="mb-3">
            {!amIBuzzing && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-2 text-center dark:bg-yellow-950 dark:border-yellow-800">
                <p className="text-xs font-medium text-yellow-800 dark:text-yellow-300">
                  {players.find(p => p.id === gridState.currentBuzzer)?.name} is answering...
                </p>
              </div>
            )}
            {amIBuzzing && (
              <>
                <label className="block text-xs font-medium text-os-text-primary mb-1.5">Your Answer:</label>
                <input
                  type="text"
                  value={myAnswer}
                  onChange={(e) => setMyAnswer(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && myAnswer.trim() && submitGridAnswer()}
                  placeholder="Type your answer here..."
                  className="w-full px-3 py-2 border-2 border-os-border rounded-sm focus:border-blue-500 focus:outline-hidden text-sm font-mono text-os-text-primary placeholder:text-os-text-muted bg-os-input-bg select-text mb-2"
                  autoFocus
                />
                <button
                  onClick={submitGridAnswer}
                  disabled={!myAnswer.trim()}
                  className="btn btn-primary w-full px-4 py-2 text-sm"
                >
                  Submit Answer
                </button>
                {gridState.incorrectAnswers && gridState.incorrectAnswers.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {gridState.incorrectAnswers.map((ia, idx) => (
                      <div key={idx} className="bg-red-50 border border-red-200 rounded-sm p-2 dark:bg-red-950 dark:border-red-800">
                        <div className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1">
                          {ia.playerName} guessed:
                        </div>
                        <div className="text-sm text-red-600 dark:text-red-300 font-mono">
                          {ia.answer}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  // Main render logic - wrap in fragment to include modal at all times
  const renderContent = () => {
    if (gameState === GAME_STATES.GAME_BROWSER) {
      return (
        <GameBrowser
          gameMode="grid"
          modeTitle="Grid"
        modeDescription="30 questions in a 6×5 grid"
        availableGames={availableGames}
        isCentralServerConnected={isCentralServerConnected}
        loadingGames={false}
        onBack={onBack}
        onCreateSinglePlayer={() => {
          setIsSinglePlayer(true);
          setGameState(GAME_STATES.CLOSED);
        }}
        onCreateMultiplayer={() => {
          setIsSinglePlayer(false);
          setGameState(GAME_STATES.CLOSED);
        }}
        onJoinGame={async (game) => {
          const playerName = selfName();

          try {
            // Set up game state FIRST to ensure event listeners are registered before server responds
            setGameId(game.gameId);
            // Preserve host status if reconnecting to own game
            const wasHost = game.canReconnect && game.hostId === currentMachineId;
            setIsHost(wasHost);
            setHostId(game.hostId || null);
            setGameState(GAME_STATES.LOBBY);
            setIsSinglePlayer(false);

            // Join the game AFTER setting state
            await sendGridJoin(game.gameId, currentMachineId, playerName);

            // Restore lobby metadata (categories/board) if reconnecting
            // Server returns selectedCategories at top level, not in metadata object
            console.log('[GridGameMode] Reconnecting - game object:', {
              canReconnect: game.canReconnect,
              hasCategories: !!game.selectedCategories,
              categoriesCount: game.selectedCategories?.length
            });

            if (game.canReconnect) {
              if (game.selectedCategories && game.selectedCategories.length > 0) {
                setGridState(prev => ({
                  ...prev,
                  selectedCategories: game.selectedCategories
                }));
                console.log('[GridGameMode] Restored', game.selectedCategories.length, 'categories from server');
              }

              // Restore AI-generated board if it exists
              if (game.aiGeneratedBoard && game.aiGeneratedBoard.length > 0) {
                setAiGeneratedBoard(game.aiGeneratedBoard);
                console.log('[GridGameMode] Restored AI-generated board with', game.aiGeneratedBoard.length, 'questions from server');
              }
            }

            // Request sync to get current game state (board, categories, etc.)
            await sendGridRequestSync(game.gameId, currentMachineId);

            console.log('[GridGameMode] Joined game from browser:', game.gameId, wasHost ? '(as host)' : '(as player)');
          } catch (error) {
            console.error('[GridGameMode] Failed to join game:', error);
          }
        }}
      />
    );
  }

    if (gameState === GAME_STATES.CLOSED) {
      return renderCategorySelection();
  }

    if (gameState === GAME_STATES.LOBBY) {
      return (
        <>
        <GameLobby
          gameMode="grid"
          gameId={gameId}
          lobbyName={lobbyName}
          players={players}
          isHost={isHost}
          hostId={hostId}
          isSinglePlayer={isSinglePlayer}
          currentMachineId={currentMachineId}
          canStart={true}
          onStart={startGame}
          onInviteApp={() => setShowInviteModal(true)}
          onShareWebLink={shareGridLink}
          onBack={async () => {
            // Send disconnect event to server before returning to browser
            if (gameId && currentMachineId) {
              try {
                await sendGridLeave(gameId, currentMachineId);
                console.log('[GridGameMode] Left lobby, notified server of disconnect');
              } catch (err) {
                console.error('[GridGameMode] Failed to notify server when leaving lobby:', err);
              }
            }
            // Return to game browser so user can see available games (including the one they just left if others are still there)
            setGameState(GAME_STATES.GAME_BROWSER);
          }}
          onUpdateLobbyName={(name) => {
            setLobbyName(name);
            if (gameId) sendLobbyNameUpdate(gameId, name);
          }}
          metadata={`Grid - ${gridState.selectedCategories.length} categories selected`}
          startButtonText="Start Grid"
        />
        <InviteModal
          isOpen={showInviteModal}
          onClose={() => setShowInviteModal(false)}
          gameId={gameId}
          gameMode="grid"
          currentPlayers={players}
        />

        <ShareLinkModal
          isOpen={showShareLinkModal}
          onClose={() => setShowShareLinkModal(false)}
          gameUrl={`${getCentralServerUrl()}/grid/${gameId}`}
          gameMode="grid"
        />
      </>
      );
    }

    if (gameState === GAME_STATES.GRID_BOARD) {
      return renderBoard();
    }

    if (gameState === GAME_STATES.GRID_QUESTION) {
      return renderQuestion();
    }

    if (gameState === GAME_STATES.RESULTS) {
      return (
        <GameResults
          gameMode="grid"
          players={players}
          scoreHistory={scoreHistory}
          currentMachineId={currentMachineId}
          onBackToGames={() => {
            setGameState(GAME_STATES.GAME_BROWSER);
            setGameId(null);
          }}
        />
      );
    }

    return null;
  };

  return (
    <>
      {renderContent()}

      {/* Save Grid Name Modal - Available at all times */}
      {showSaveGridModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-os-card rounded-lg p-6 max-w-md w-full mx-4 border border-os-border">
            <h3 className="text-lg font-semibold text-os-text-primary mb-4">Save Custom Grid</h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-os-text-secondary mb-2">Grid Name</label>
              <input
                type="text"
                value={saveGridName}
                onChange={(e) => setSaveGridName(e.target.value)}
                className="w-full px-3 py-2 bg-os-card-secondary border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                placeholder="Enter grid name..."
                autoFocus
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && saveGridName.trim()) {
                    saveAIGridAsCustom();
                  }
                }}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowSaveGridModal(false);
                  setSaveGridName('');
                }}
                className="px-4 py-2 bg-os-card-secondary text-os-text-secondary rounded-sm hover:bg-os-border transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveAIGridAsCustom}
                disabled={!saveGridName.trim()}
                className="btn btn-success px-4 py-2"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal (replaces native confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </>
  );
}
