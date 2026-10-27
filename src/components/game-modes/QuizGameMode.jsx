import { useState, useEffect, useRef } from 'react';
import { Clock, Lightbulb, FileCode, GitBranch, Package, Network, Code, Server, Play, X, Sparkles, Save, FolderOpen, Link, Upload, Trash2, Download } from 'lucide-react';
import {
  GAME_STATES,
  POINTS_PER_QUESTION,
  POINTS_DEDUCTION_PER_HINT,
  QUESTION_TIME_SECONDS
} from '../../constants/gameConstants';
import { useQuizEventListeners } from '../../hooks/useQuizEventListeners';
import {
  sendQuizJoin,
  sendQuizStart,
  sendQuizSubmitGuess,
  sendQuizLeave,
  sendQuizSyncPlayers,
  sendQuizRequestSync,
  sendLobbyNameUpdate,
  sendLobbyMetadataUpdate,
  onLobbyNameUpdate,
  fetchAvailableGames
} from '../../utils/cloudWebSocket';
import { generateAIQuizQuestions, generateQuizFromURL, generateQuizFromFile } from '../../utils/aiQuizGenerator';
import { getAllCustomQuizzes, addCustomQuiz, deleteCustomQuiz } from '../../utils/customContentDB';
import { fuzzyMatchAnswer } from '../../utils/answerMatching';
import { getCentralServerUrl } from '../../utils/cloudCentralSync';
import { notifyCentralUnavailable } from '../../utils/centralAvailability';
import { useDisplayName } from '../../hooks/useDisplayName';
import { getQuestionsForQuizType } from '../../data/quizQuestions';
import GameBrowser from '../game-shared/GameBrowser';
import GameLobby from '../game-shared/GameLobby';
import GameResults from '../game-shared/GameResults';
import InviteModal from '../game-shared/InviteModal';
import ShareLinkModal from '../game-shared/ShareLinkModal';
import ConfirmationModal from '../common/modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import { useNotifications } from '../../contexts/NotificationContext';

// Available quiz types (standard topics only)
const QUIZ_TYPES = [
  { id: 'linux-basics', title: 'Linux Basics', icon: FileCode, color: 'blue' },
  { id: 'docker', title: 'Docker', icon: Package, color: 'cyan' },
  { id: 'git', title: 'Git', icon: GitBranch, color: 'orange' },
  { id: 'networking', title: 'Networking', icon: Network, color: 'green' },
  { id: 'python', title: 'Python', icon: Code, color: 'yellow' },
  { id: 'kubernetes', title: 'Kubernetes', icon: Server, color: 'indigo' },
];

/**
 * QuizGameMode - Complete Quiz game mode implementation
 * 10 question quiz with hints and timer
 *
 * @param {Object} props
 * @param {Function} props.onBack - Callback to return to mode selection
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {boolean} props.isCentralServerConnected - Connection status
 * @param {Object} props.pendingChallenge - Challenge details if joining via invite
 * @param {Function} props.onChallengeHandled - Callback when challenge has been handled
 */
export default function QuizGameMode({ onBack, currentMachineId, isCentralServerConnected, pendingChallenge, onChallengeHandled }) {
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
  const [availableGames, setAvailableGames] = useState([]);

  // Quiz-specific state
  const [quizMode, setQuizMode] = useState('standard'); // 'standard', 'ai-generated', 'custom'
  const [selectedQuizType, setSelectedQuizType] = useState(null);
  const [quizQuestions, setQuizQuestions] = useState([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [hintsRevealed, setHintsRevealed] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(QUESTION_TIME_SECONDS);
  const [localTimeRemaining, setLocalTimeRemaining] = useState(QUESTION_TIME_SECONDS);
  const quizTimerRef = useRef(null);
  const [myAnswer, setMyAnswer] = useState('');
  const [questionAnswers, setQuestionAnswers] = useState([]);
  const [hasAnsweredCurrentQuestion, setHasAnsweredCurrentQuestion] = useState(false);
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [revealedAnswer, setRevealedAnswer] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showShareLinkModal, setShowShareLinkModal] = useState(false);

  // AI generation state
  const [aiInputMode, setAiInputMode] = useState('topic'); // 'topic', 'url', 'file'
  const [aiTopicName, setAiTopicName] = useState('');
  const [aiDocUrl, setAiDocUrl] = useState('');
  const [aiUrlTopic, setAiUrlTopic] = useState('');
  const [aiSelectedFile, setAiSelectedFile] = useState(null);
  const [aiFileTopic, setAiFileTopic] = useState('');
  const [aiDifficultyYears, setAiDifficultyYears] = useState(5);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [aiGeneratedQuestions, setAiGeneratedQuestions] = useState([]);

  // Custom quizzes state
  const [customQuizzes, setCustomQuizzes] = useState([]);
  const [loadingCustomQuizzes, setLoadingCustomQuizzes] = useState(false);

  // Event listeners
  useQuizEventListeners({
    gameId,
    isHost,
    currentMachineId,
    QUIZ_TYPES,
    players,
    quizQuestions,
    currentQuestionIndex,
    hintsRevealed,
    timeRemaining,
    questionAnswers,
    scoreHistory,
    gameState,
    setPlayers,
    setGameState,
    setQuizQuestions,
    setSelectedQuizType,
    setCurrentQuestionIndex,
    setTimeRemaining,
    setHintsRevealed,
    setQuestionAnswers,
    setScoreHistory,
    setMyAnswer,
    setHasAnsweredCurrentQuestion,
    setShowingAnswer,
    setRevealedAnswer,
    setLobbyName,
    sendQuizSyncPlayers
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
        console.error('[QuizGameMode] Failed to fetch available games:', error);
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
      if (gameId && currentMachineId && !isSinglePlayer && (gameState === GAME_STATES.LOBBY || gameState === GAME_STATES.PLAYING)) {
        console.log('[QuizGameMode] Window closing, notifying server of disconnect');
        sendQuizLeave(gameId, currentMachineId).catch(err =>
          console.error('[QuizGameMode] Failed to notify server of exit:', err)
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

    // Only handle if it's a quiz game (not grid or tiles)
    if (acceptedGameId.startsWith('grid-') || acceptedGameId.startsWith('tiles-')) {
      return;
    }

    console.log('[QuizGameMode] Handling pending challenge, joining game:', acceptedGameId);

    const playerName = selfName();

    // Send join event first - server will send player sync
    (async () => {
      try {
        await sendQuizJoin(acceptedGameId, currentMachineId, playerName);
        console.log('[QuizGameMode] Joined game:', acceptedGameId);

        // After successful join, set game state
        // Don't set players - let the server sync handle it
        setGameId(acceptedGameId);
        setIsHost(false);
        setGameState(GAME_STATES.LOBBY);
        setIsSinglePlayer(false);

        // Mark challenge as handled
        if (onChallengeHandled) {
          onChallengeHandled();
        }
      } catch (error) {
        console.error('[QuizGameMode] Failed to join game:', error);
      }
    })();
    // selfName is read once, when the accepted challenge is joined; it is a plain function remade on every
    // render and changes with the display name, and a name change must not join the game again
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selfName: read at join time only (see above)
  }, [pendingChallenge, currentMachineId, onChallengeHandled]);

  // Timer countdown - smooth synchronized timer
  useEffect(() => {
    if (quizTimerRef.current) {
      clearInterval(quizTimerRef.current);
      quizTimerRef.current = null;
    }

    if (gameState !== GAME_STATES.PLAYING || timeRemaining <= 0) {
      // Intentional sync of the smooth display timer with the
      // authoritative timer state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalTimeRemaining(timeRemaining);
      return;
    }

    // For multiplayer, use server's authoritative time
    if (!isSinglePlayer) {
      setLocalTimeRemaining(timeRemaining);
      return;
    }

    // For single player, run local countdown
    const updateTimer = () => {
      setTimeRemaining(prev => {
        const newTime = prev - 1;
        if (newTime <= 0) {
          // Move to next question or end quiz
          if (currentQuestionIndex < quizQuestions.length - 1) {
            setCurrentQuestionIndex(idx => idx + 1);
            setHintsRevealed(0);
            setHasAnsweredCurrentQuestion(false);
            setShowingAnswer(false);
            setMyAnswer('');
            setLocalTimeRemaining(QUESTION_TIME_SECONDS);
            return QUESTION_TIME_SECONDS;
          } else {
            setGameState(GAME_STATES.RESULTS);
            setLocalTimeRemaining(0);
            return 0;
          }
        }
        setLocalTimeRemaining(newTime);
        return newTime;
      });
    };

    quizTimerRef.current = setInterval(updateTimer, 1000);

    return () => {
      if (quizTimerRef.current) {
        clearInterval(quizTimerRef.current);
        quizTimerRef.current = null;
      }
    };
  }, [gameState, timeRemaining, currentQuestionIndex, quizQuestions.length, isSinglePlayer]);

  // Smooth display update for multiplayer timer
  useEffect(() => {
    if (isSinglePlayer) return;
    // Intentional sync with the server's authoritative countdown.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalTimeRemaining(timeRemaining);
  }, [timeRemaining, isSinglePlayer]);

  // Handlers
  // Notify the server we're leaving the current multiplayer game/lobby.
  // Needed on every explicit exit path (quit X button, lobby back button):
  // unlike closing the floating window (which fires 'floatingQuizClosing'),
  // these paths fire no event and the app's shared socket stays connected,
  // so without quiz-leave the server would keep this player marked
  // connected and the abandoned game listed under "Running Games" forever.
  function notifyServerLeaving() {
    if (gameId && currentMachineId && !isSinglePlayer) {
      sendQuizLeave(gameId, currentMachineId).catch(err =>
        console.error('[QuizGameMode] Failed to notify server of exit:', err)
      );
    }
  }

  // Quit an in-progress game via the X button (back to mode selection)
  function quitToModeSelect() {
    notifyServerLeaving();
    onBack();
  }

  async function selectQuizType(quizTypeId) {
    setSelectedQuizType(quizTypeId);

    // Load real questions for the selected quiz type
    const questions = getQuestionsForQuizType(quizTypeId);
    const categoryTitle = QUIZ_TYPES.find(qt => qt.id === quizTypeId)?.title || quizTypeId;

    // Add IDs and category to each question
    const questionsWithMetadata = questions.map((q, i) => ({
      id: `q${i + 1}`,
      category: categoryTitle,
      ...q
    }));

    setQuizQuestions(questionsWithMetadata);
  }

  async function loadCustomQuizzes() {
    try {
      setLoadingCustomQuizzes(true);
      const quizzes = await getAllCustomQuizzes();
      setCustomQuizzes(quizzes);
      console.log('[Quiz] Loaded', quizzes.length, 'custom quizzes');
    } catch (error) {
      console.error('[Quiz] Failed to load custom quizzes:', error);
    } finally {
      setLoadingCustomQuizzes(false);
    }
  }

  async function generateAIQuiz() {
    try {
      setIsGenerating(true);
      setGenerationStatus('Generating questions...');

      let questions;
      if (aiInputMode === 'topic') {
        questions = await generateAIQuizQuestions({
          topic: aiTopicName,
          numQuestions: 10,
          difficultyYears: aiDifficultyYears
        });
      } else if (aiInputMode === 'url') {
        questions = await generateQuizFromURL({
          url: aiDocUrl,
          focusTopic: aiUrlTopic,
          numQuestions: 10,
          difficultyYears: aiDifficultyYears
        });
      } else if (aiInputMode === 'file') {
        questions = await generateQuizFromFile({
          file: aiSelectedFile,
          focusTopic: aiFileTopic,
          numQuestions: 10,
          difficultyYears: aiDifficultyYears
        });
      }

      setAiGeneratedQuestions(questions);
      setQuizQuestions(questions);
      setGenerationStatus('Generation complete!');
      console.log('[Quiz] Generated', questions.length, 'AI questions');

    } catch (error) {
      console.error('[Quiz] AI generation failed:', error);
      setGenerationStatus(`Error: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  }

  function downloadAIQuizAsJSON() {
    if (aiGeneratedQuestions.length === 0) return;

    const quizName = aiInputMode === 'topic'
      ? `AI Quiz: ${aiTopicName}`
      : aiInputMode === 'url'
      ? `AI Quiz: ${aiDocUrl.substring(0, 50)}...`
      : `AI Quiz: ${aiSelectedFile.name}`;

    const customQuiz = {
      id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: quizName,
      type: 'ai-generated',
      questions: aiGeneratedQuestions,
      difficulty: aiDifficultyYears,
      createdAt: new Date().toISOString()
    };

    const jsonString = JSON.stringify(customQuiz, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${quizName.replace(/[^a-z0-9]/gi, '_')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    console.log('[Quiz] Downloaded AI quiz as JSON:', quizName);
  }

  async function saveAIQuizAsCustom() {
    if (aiGeneratedQuestions.length === 0) return;

    try {
      const quizName = aiInputMode === 'topic'
        ? `AI Quiz: ${aiTopicName}`
        : aiInputMode === 'url'
        ? `AI Quiz: ${aiDocUrl.substring(0, 50)}...`
        : `AI Quiz: ${aiSelectedFile.name}`;

      const customQuiz = {
        id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: quizName,
        type: 'ai-generated',
        questions: aiGeneratedQuestions,
        difficulty: aiDifficultyYears,
        createdAt: new Date().toISOString()
      };

      await addCustomQuiz(customQuiz);
      console.log('[Quiz] Saved AI quiz as custom:', quizName);
      addNotification({
        type: 'success',
        title: 'Quiz Saved',
        message: 'Quiz saved successfully!'
      });

    } catch (error) {
      console.error('[Quiz] Failed to save custom quiz:', error);
      addNotification({
        type: 'error',
        title: 'Save Failed',
        message: 'Failed to save quiz: ' + error.message
      });
    }
  }

  async function loadCustomQuiz(quiz) {
    setQuizQuestions(quiz.questions);
    console.log('[Quiz] Loaded custom quiz:', quiz.name);
  }

  async function deleteCustomQuizHandler(quizId) {
    if (!(await confirm({
      title: 'Delete Custom Quiz',
      message: 'Are you sure you want to delete this custom quiz?',
      type: 'danger',
      confirmLabel: 'Delete',
    }))) return;

    try {
      await deleteCustomQuiz(quizId);
      await loadCustomQuizzes();
      console.log('[Quiz] Deleted custom quiz:', quizId);
    } catch (error) {
      console.error('[Quiz] Failed to delete custom quiz:', error);
      addNotification({
        type: 'error',
        title: 'Delete Failed',
        message: 'Failed to delete quiz: ' + error.message
      });
    }
  }

  async function importQuizFromJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const quiz = JSON.parse(text);

        // Validate structure
        if (!quiz.questions || !Array.isArray(quiz.questions)) {
          throw new Error('Invalid quiz format: missing questions array');
        }

        // Ensure required fields
        const importedQuiz = {
          id: quiz.id || `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: quiz.name || file.name.replace('.json', ''),
          type: quiz.type || 'imported',
          questions: quiz.questions,
          difficulty: quiz.difficulty || 5,
          createdAt: quiz.createdAt || new Date().toISOString()
        };

        await addCustomQuiz(importedQuiz);
        await loadCustomQuizzes();
        console.log('[Quiz] Imported quiz:', importedQuiz.name);
        addNotification({
          type: 'success',
          title: 'Quiz Imported',
          message: `Successfully imported: ${importedQuiz.name}`
        });
      } catch (error) {
        console.error('[Quiz] Failed to import quiz:', error);
        addNotification({
          type: 'error',
          title: 'Import Failed',
          message: 'Failed to import quiz: ' + error.message
        });
      }
    };
    input.click();
  }

  async function createLobby() {
    const newGameId = `quiz-${Date.now()}`;
    const playerName = selfName();

    setGameId(newGameId);
    setIsHost(true);
    setHostId(currentMachineId);

    const defaultLobbyName = `${playerName}'s Quiz`;
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
      setGameState(GAME_STATES.PLAYING);
      setCurrentQuestionIndex(0);
      setTimeRemaining(QUESTION_TIME_SECONDS);
      setHintsRevealed(0);
      setHasAnsweredCurrentQuestion(false);
      setScoreHistory({ [currentMachineId]: [0] });
    } else {
      // Multiplayer: Create lobby
      setGameState(GAME_STATES.LOBBY);
      try {
        await sendQuizJoin(newGameId, currentMachineId, playerName);
        await sendLobbyNameUpdate(newGameId, defaultLobbyName);
        // Store quiz questions in lobby metadata so they survive reconnection
        console.log('[QuizGameMode] Storing lobby metadata:', {
          quizType: selectedQuizType,
          questionsCount: quizQuestions.length
        });
        await sendLobbyMetadataUpdate(newGameId, {
          quizType: selectedQuizType,
          questions: quizQuestions
        });
      } catch (error) {
        console.error('[Quiz] Failed to create lobby:', error);
      }
    }
  }

  function shareQuizLink() {
    if (!gameId) return;

    const centralServerUrl = getCentralServerUrl();

    if (!centralServerUrl) {
      notifyCentralUnavailable(addNotification, 'share a game link');
      return;
    }

    setShowShareLinkModal(true);
  }

  async function startGame() {
    if (!isHost || !gameId || quizQuestions.length === 0) return;

    setGameState(GAME_STATES.PLAYING);
    setCurrentQuestionIndex(0);
    setTimeRemaining(QUESTION_TIME_SECONDS);
    setHintsRevealed(0);
    setHasAnsweredCurrentQuestion(false);

    if (!isSinglePlayer) {
      try {
        await sendQuizStart(gameId, quizQuestions);
      } catch (error) {
        console.error('[Quiz] Failed to start:', error);
      }
    }
  }

  async function submitAnswer() {
    if (!myAnswer.trim() || hasAnsweredCurrentQuestion) return;

    const currentQuestion = quizQuestions[currentQuestionIndex];
    if (!currentQuestion) return;

    setHasAnsweredCurrentQuestion(true);

    if (isSinglePlayer) {
      // Local validation
      const isCorrect = fuzzyMatchAnswer(myAnswer.trim(), currentQuestion.answer);
      const points = isCorrect
        ? Math.max(10, POINTS_PER_QUESTION - (hintsRevealed * POINTS_DEDUCTION_PER_HINT))
        : 0;

      // Update score
      setPlayers(prev => prev.map(p =>
        p.id === currentMachineId ? { ...p, score: (p.score || 0) + points } : p
      ));

      // Update score history
      setScoreHistory(prev => ({
        ...prev,
        [currentMachineId]: [...(prev[currentMachineId] || [0]), (prev[currentMachineId]?.slice(-1)[0] || 0) + points]
      }));

      setQuestionAnswers(prev => [...prev, { questionId: currentQuestion.id, playerId: currentMachineId, correct: isCorrect, points }]);

      // Show answer briefly before moving to next
      setShowingAnswer(true);
      setRevealedAnswer(currentQuestion.answer);

      setTimeout(() => {
        if (currentQuestionIndex < quizQuestions.length - 1) {
          setCurrentQuestionIndex(idx => idx + 1);
          setHintsRevealed(0);
          setHasAnsweredCurrentQuestion(false);
          setShowingAnswer(false);
          setTimeRemaining(QUESTION_TIME_SECONDS);
          setMyAnswer('');
        } else {
          setGameState(GAME_STATES.RESULTS);
        }
      }, 3000);
    } else {
      try {
        await sendQuizSubmitGuess(gameId, currentMachineId, currentQuestion.id, myAnswer.trim(), hintsRevealed);
      } catch (error) {
        console.error('[Quiz] Failed to submit answer:', error);
      }
    }

    setMyAnswer('');
  }

  function requestHint() {
    const currentQuestion = quizQuestions[currentQuestionIndex];
    if (hintsRevealed < currentQuestion?.hints?.length) {
      setHintsRevealed(prev => prev + 1);
    }
  }

  // Render functions
  const renderQuizTypeSelection = () => {
    return (
      <div className="flex-1 flex flex-col p-4 overflow-y-auto">
        <div className="mb-4">
          <button onClick={() => setGameState(GAME_STATES.GAME_BROWSER)} className="text-xs text-os-text-secondary hover:text-os-text-primary mb-2">
            ← Back
          </button>
          <h2 className="text-lg font-bold text-os-text-primary">Quiz Setup</h2>

          {/* Mode Toggle */}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => {
                setQuizMode('standard');
                setQuizQuestions([]);
                setAiGeneratedQuestions([]);
              }}
              className={`px-3 py-1.5 text-xs rounded border ${
                quizMode === 'standard'
                  ? 'btn-selected-soft'
                  : 'bg-os-card border-os-border text-os-text-secondary'
              }`}
            >
              Standard
            </button>
            <button
              onClick={() => {
                setQuizMode('ai-generated');
                setQuizQuestions([]);
                setSelectedQuizType(null);
              }}
              className={`px-3 py-1.5 text-xs rounded border ${
                quizMode === 'ai-generated'
                  ? 'btn-brand-soft'
                  : 'bg-os-card border-os-border text-os-text-secondary'
              }`}
            >
              <Sparkles size={12} className="inline mr-1" />
              AI Generated
            </button>
            <button
              onClick={() => {
                setQuizMode('custom');
                setQuizQuestions([]);
                setSelectedQuizType(null);
                setAiGeneratedQuestions([]);
                loadCustomQuizzes();
              }}
              className={`px-3 py-1.5 text-xs rounded border ${
                quizMode === 'custom'
                  ? 'btn-selected-soft'
                  : 'bg-os-card border-os-border text-os-text-secondary'
              }`}
            >
              <FolderOpen size={12} className="inline mr-1" />
              Custom
            </button>
          </div>
        </div>

        {/* Standard Topics */}
        {quizMode === 'standard' && (
          <>
            <p className="text-xs text-os-text-secondary mb-3">Choose a topic for your quiz</p>
            <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border mb-4">
              <h3 className="text-sm font-semibold text-os-text-primary mb-3">Choose Topic</h3>
              <div className="grid grid-cols-2 gap-2">
                {QUIZ_TYPES.map((quizType) => {
                  const Icon = quizType.icon;
                  const isSelected = selectedQuizType === quizType.id;
                  return (
                    <button
                      key={quizType.id}
                      onClick={() => selectQuizType(quizType.id)}
                      className={`px-2 py-2 text-left text-xs border rounded transition-all flex items-center gap-2 ${
                        isSelected
                          ? 'btn btn-selected-soft border-2'
                          : 'bg-os-card border-os-border hover:bg-os-card-secondary hover:border-os-border'
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

        {/* AI Quiz Generation UI */}
        {quizMode === 'ai-generated' && (
          <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border mb-4">
            <h3 className="text-sm font-semibold text-os-text-primary mb-3 flex items-center gap-2">
              <Sparkles size={14} className="text-purple-600" />
              AI Quiz Generator
            </h3>

            {/* Input Mode Selection */}
            <div className="mb-3">
              <label className="text-xs text-os-text-secondary mb-2 block">Source:</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setAiInputMode('topic')}
                  className={`px-3 py-1.5 text-xs rounded border ${
                    aiInputMode === 'topic'
                      ? 'btn-brand-soft'
                      : 'bg-os-card border-os-border text-os-text-secondary'
                  }`}
                >
                  Topic
                </button>
                <button
                  onClick={() => setAiInputMode('url')}
                  className={`px-3 py-1.5 text-xs rounded border ${
                    aiInputMode === 'url'
                      ? 'btn-brand-soft'
                      : 'bg-os-card border-os-border text-os-text-secondary'
                  }`}
                >
                  <Link size={12} className="inline mr-1" />
                  URL
                </button>
                <button
                  onClick={() => setAiInputMode('file')}
                  className={`px-3 py-1.5 text-xs rounded border ${
                    aiInputMode === 'file'
                      ? 'btn-brand-soft'
                      : 'bg-os-card border-os-border text-os-text-secondary'
                  }`}
                >
                  <Upload size={12} className="inline mr-1" />
                  File
                </button>
              </div>
            </div>

            {/* Topic Input */}
            {aiInputMode === 'topic' && (
              <div className="mb-3">
                <label className="text-xs text-os-text-secondary mb-1 block">Topic Name:</label>
                <input
                  type="text"
                  value={aiTopicName}
                  onChange={(e) => setAiTopicName(e.target.value)}
                  placeholder="e.g., Docker Networking"
                  className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                />
              </div>
            )}

            {/* URL Input */}
            {aiInputMode === 'url' && (
              <>
                <div className="mb-2">
                  <label className="text-xs text-os-text-secondary mb-1 block">Documentation URL:</label>
                  <input
                    type="url"
                    value={aiDocUrl}
                    onChange={(e) => setAiDocUrl(e.target.value)}
                    placeholder="https://docs.example.com/guide"
                    className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                  />
                </div>
                <div className="mb-3">
                  <label className="text-xs text-os-text-secondary mb-1 block">Focus Topic (optional):</label>
                  <input
                    type="text"
                    value={aiUrlTopic}
                    onChange={(e) => setAiUrlTopic(e.target.value)}
                    placeholder="e.g., Authentication"
                    className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                  />
                </div>
              </>
            )}

            {/* File Input */}
            {aiInputMode === 'file' && (
              <>
                <div className="mb-2">
                  <label className="text-xs text-os-text-secondary mb-1 block">Upload Document:</label>
                  <input
                    type="file"
                    accept=".txt,.md,.json,.yaml,.yml"
                    onChange={(e) => setAiSelectedFile(e.target.files[0])}
                    className="w-full text-xs text-os-text-secondary file:mr-2 file:py-1.5 file:px-3 file:rounded-sm file:border-0 file:text-xs file:bg-purple-50 file:text-purple-700 dark:file:bg-purple-950 dark:file:text-purple-300"
                  />
                  {aiSelectedFile && (
                    <p className="text-xs text-os-text-muted mt-1">{aiSelectedFile.name}</p>
                  )}
                </div>
                <div className="mb-3">
                  <label className="text-xs text-os-text-secondary mb-1 block">Focus Topic (optional):</label>
                  <input
                    type="text"
                    value={aiFileTopic}
                    onChange={(e) => setAiFileTopic(e.target.value)}
                    placeholder="e.g., Configuration"
                    className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-border rounded-sm focus:outline-hidden focus:border-purple-500"
                  />
                </div>
              </>
            )}

            {/* Difficulty Slider */}
            <div className="mb-3">
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
              onClick={generateAIQuiz}
              disabled={
                isGenerating ||
                (aiInputMode === 'topic' && !aiTopicName.trim()) ||
                (aiInputMode === 'url' && !aiDocUrl.trim()) ||
                (aiInputMode === 'file' && !aiSelectedFile)
              }
              className="btn btn-brand w-full px-3 py-2 text-sm flex items-center justify-center gap-2 mb-2"
            >
              <Sparkles size={14} />
              {isGenerating ? 'Generating...' : 'Generate Questions'}
            </button>

            {/* Status */}
            {generationStatus && (
              <p className="text-xs text-os-text-secondary text-center">{generationStatus}</p>
            )}

            {/* Action Buttons */}
            {aiGeneratedQuestions.length > 0 && (
              <div className="flex gap-2 mt-2">
                <button
                  onClick={downloadAIQuizAsJSON}
                  className="btn btn-primary flex-1 px-3 py-2 text-sm flex items-center justify-center gap-2"
                >
                  <Download size={14} />
                  Download JSON
                </button>
                <button
                  onClick={saveAIQuizAsCustom}
                  className="btn btn-success flex-1 px-3 py-2 text-sm flex items-center justify-center gap-2"
                >
                  <Save size={14} />
                  Save as Custom
                </button>
              </div>
            )}
          </div>
        )}

        {/* Custom Quizzes UI */}
        {quizMode === 'custom' && (
          <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-os-text-primary flex items-center gap-2">
                <FolderOpen size={14} className="text-blue-600" />
                Custom Quizzes
              </h3>
              <button
                onClick={importQuizFromJSON}
                className="btn btn-primary px-2 py-1 text-xs flex items-center gap-1"
              >
                <Upload size={12} />
                Import JSON
              </button>
            </div>

            {loadingCustomQuizzes ? (
              <p className="text-xs text-os-text-secondary text-center py-4">Loading...</p>
            ) : customQuizzes.length === 0 ? (
              <p className="text-xs text-os-text-secondary text-center py-4">
                No custom quizzes saved. Generate an AI quiz and save it, or import a JSON file!
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {customQuizzes.map((quiz) => (
                  <div
                    key={quiz.id}
                    className="bg-os-card p-3 rounded-sm border border-os-border flex items-center justify-between"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-os-text-primary truncate">
                        {quiz.name}
                      </p>
                      <p className="text-xs text-os-text-secondary">
                        {quiz.questions?.length || 0} questions • {new Date(quiz.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex gap-2 ml-2">
                      <button
                        onClick={() => loadCustomQuiz(quiz)}
                        className="btn btn-primary px-2 py-1 text-xs"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => deleteCustomQuizHandler(quiz.id)}
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
          disabled={quizQuestions.length === 0}
          className="btn btn-primary w-full px-3 py-2 text-sm flex items-center justify-center gap-2"
        >
          <Play size={16} />
          {isSinglePlayer ? 'Start Quiz' : 'Create Lobby'}
        </button>
      </div>
    );
  };

  const renderQuestion = () => {
    const currentQuestion = quizQuestions[currentQuestionIndex];
    if (!currentQuestion) return null;

    const currentPoints = POINTS_PER_QUESTION - (hintsRevealed * POINTS_DEDUCTION_PER_HINT);

    return (
      <div className="flex-1 flex flex-col p-4 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-os-text-muted">
              Question {currentQuestionIndex + 1} / {quizQuestions.length}
            </span>
            <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-sm font-medium dark:bg-blue-950 dark:text-blue-400">
              {currentQuestion.category}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-orange-600">
              <Clock size={14} />
              <span className="font-bold text-sm">{localTimeRemaining}s</span>
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

        {/* Question */}
        <div className="bg-os-card-secondary rounded-sm p-3 mb-3 border border-os-border">
          <p className="text-sm font-semibold text-os-text-primary">{currentQuestion.question}</p>
        </div>

        {/* Points */}
        <div className="flex items-center justify-between mb-3 bg-green-50 border border-green-200 p-2 rounded-sm dark:bg-green-950 dark:border-green-800">
          <span className="text-xs font-medium text-os-text-primary">Points available:</span>
          <span className="text-lg font-bold text-green-600">{currentPoints}</span>
        </div>

        {/* Hints */}
        {hintsRevealed > 0 && !showingAnswer && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-sm p-2.5 mb-3 dark:bg-yellow-950 dark:border-yellow-800">
            <h4 className="text-xs font-semibold text-yellow-800 dark:text-yellow-200 mb-1.5 flex items-center gap-1.5">
              <Lightbulb size={12} />
              Hints:
            </h4>
            <ul className="list-disc list-inside space-y-0.5">
              {currentQuestion.hints.slice(0, hintsRevealed).map((hint, i) => (
                <li key={i} className="text-yellow-700 dark:text-yellow-300 text-xs">{hint}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Correct Answer Display */}
        {showingAnswer && (isSinglePlayer ? currentQuestion.answer : revealedAnswer) && (
          <div className="bg-blue-50 border-2 border-blue-400 rounded-sm p-3 mb-3 animate-pulse dark:bg-blue-950 dark:border-blue-800">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-blue-800 dark:text-blue-300">Correct Answer:</h4>
              <span className="text-xs text-blue-600 dark:text-blue-400">Moving to next question...</span>
            </div>
            <p className="text-lg font-bold text-blue-900 dark:text-blue-200 font-mono text-center">
              {isSinglePlayer ? currentQuestion.answer : revealedAnswer}
            </p>
          </div>
        )}

        {/* Answer Input */}
        {!showingAnswer && (
          <div className="mb-3">
            <label className="block text-xs font-medium text-os-text-primary mb-1.5">Your Answer:</label>
            <input
              type="text"
              value={myAnswer}
              onChange={(e) => setMyAnswer(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && myAnswer.trim() && !hasAnsweredCurrentQuestion && submitAnswer()}
              placeholder={hasAnsweredCurrentQuestion ? "Answer submitted" : "Type your answer here..."}
              disabled={hasAnsweredCurrentQuestion}
              className="w-full px-3 py-2 border-2 border-os-border rounded-sm focus:border-blue-500 focus:outline-hidden text-sm font-mono text-os-text-primary placeholder:text-os-text-muted bg-os-input-bg disabled:bg-os-card-secondary disabled:cursor-not-allowed select-text"
              autoFocus={!hasAnsweredCurrentQuestion}
            />
          </div>
        )}

        {/* Actions */}
        {!showingAnswer && (
          <div className="flex gap-2 mb-3">
            <button
              onClick={submitAnswer}
              disabled={!myAnswer.trim() || hasAnsweredCurrentQuestion}
              className="btn btn-primary flex-1 px-4 py-2 text-sm"
            >
              {hasAnsweredCurrentQuestion ? '✓ Submitted - Waiting for others...' : 'Submit Answer'}
            </button>
            <button
              onClick={requestHint}
              disabled={hintsRevealed >= currentQuestion.hints.length || hasAnsweredCurrentQuestion}
              className="btn btn-warning px-4 py-2 disabled:bg-os-card-secondary disabled:text-os-text-muted text-sm flex items-center gap-1.5"
            >
              <Lightbulb size={14} />
              Hint (-{POINTS_DEDUCTION_PER_HINT})
            </button>
          </div>
        )}

        {/* Player Scores */}
        <div className="pt-3 border-t border-os-border">
          <h4 className="text-xs font-semibold text-os-text-primary mb-2">Current Standings:</h4>
          <div className="space-y-1.5">
            {[...players].sort((a, b) => b.score - a.score).map((player, index) => {
              const hasAnswered = questionAnswers.some(
                qa => qa.playerId === player.id && qa.questionId === quizQuestions[currentQuestionIndex]?.id
              );

              return (
                <div
                  key={player.id}
                  className={`flex items-center justify-between bg-os-card-secondary px-2.5 py-1.5 rounded border border-os-border ${
                    player.connected === false ? 'opacity-60' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-os-text-muted w-4">#{index + 1}</span>
                    <span className="text-xs font-medium text-os-text-primary">{player.name}</span>
                    {player.connected === false && (
                      <span className="text-xs bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded-sm">Disconnected</span>
                    )}
                    {player.id === currentMachineId && player.connected !== false && (
                      <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-sm dark:bg-blue-950 dark:text-blue-400">You</span>
                    )}
                    {hasAnswered && player.connected !== false && (
                      <span className="text-xs bg-green-50 text-green-600 px-1.5 py-0.5 rounded-sm dark:bg-green-950 dark:text-green-400">✓ Answered</span>
                    )}
                  </div>
                  <span className="text-sm font-bold text-os-text-primary">{player.score}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // Main render logic
  if (gameState === GAME_STATES.GAME_BROWSER) {
    return (
      <GameBrowser
        gameMode="quiz"
        modeTitle="Quiz"
        modeDescription="10 random questions"
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
            await sendQuizJoin(game.gameId, currentMachineId, playerName);

            // Restore lobby metadata (questions) if reconnecting
            console.log('[QuizGameMode] Reconnecting - game object:', {
              canReconnect: game.canReconnect,
              hasQuestions: !!game.questions,
              questionsCount: game.questions?.length,
              quizType: game.quizType
            });

            // Server returns questions/quizType at top level, not in metadata object
            if (game.canReconnect) {
              if (game.questions && game.questions.length > 0) {
                setQuizQuestions(game.questions);
                console.log('[QuizGameMode] Restored', game.questions.length, 'questions from server');
              }
              if (game.quizType) {
                setSelectedQuizType(game.quizType);
                console.log('[QuizGameMode] Restored quiz type:', game.quizType);
              }
            }

            // Request sync to get current game state (questions, etc.)
            await sendQuizRequestSync(game.gameId, currentMachineId);

            console.log('[QuizGameMode] Joined game from browser:', game.gameId, wasHost ? '(as host)' : '(as player)');
          } catch (error) {
            console.error('[QuizGameMode] Failed to join game:', error);
          }
        }}
      />
    );
  }

  if (gameState === GAME_STATES.CLOSED) {
    return (
      <>
        {renderQuizTypeSelection()}
        {/* Confirmation Modal (replaces native confirm for custom quiz deletion) */}
        <ConfirmationModal {...confirmationProps} />
      </>
    );
  }

  if (gameState === GAME_STATES.LOBBY) {
    return (
      <>
        <GameLobby
          gameMode="quiz"
          gameId={gameId}
          lobbyName={lobbyName}
          players={players}
          isHost={isHost}
          hostId={hostId}
          isSinglePlayer={isSinglePlayer}
          currentMachineId={currentMachineId}
          canStart={quizQuestions.length > 0}
          onStart={startGame}
          onInviteApp={() => setShowInviteModal(true)}
          onShareWebLink={shareQuizLink}
          onBack={() => {
            // Tell the server we're leaving so the lobby doesn't keep us
            // listed as a connected player forever
            notifyServerLeaving();
            // Return to game browser so user can see available games (including the one they just left if others are still there)
            setGameState(GAME_STATES.GAME_BROWSER);
          }}
          onUpdateLobbyName={(name) => {
            setLobbyName(name);
            if (gameId) sendLobbyNameUpdate(gameId, name);
          }}
          metadata={`Quiz - ${selectedQuizType || 'No topic selected'} (${quizQuestions.length} questions)`}
          startButtonText={`Start Quiz (${quizQuestions.length} Questions)`}
        />
        <InviteModal
          isOpen={showInviteModal}
          onClose={() => setShowInviteModal(false)}
          gameId={gameId}
          gameMode="quiz"
          currentPlayers={players}
        />

        <ShareLinkModal
          isOpen={showShareLinkModal}
          onClose={() => setShowShareLinkModal(false)}
          gameUrl={`${getCentralServerUrl()}/quiz/${gameId}`}
          gameMode="quiz"
        />
      </>
    );
  }

  if (gameState === GAME_STATES.PLAYING) {
    return renderQuestion();
  }

  if (gameState === GAME_STATES.RESULTS) {
    return (
      <GameResults
        gameMode="quiz"
        players={players}
        scoreHistory={scoreHistory}
        currentMachineId={currentMachineId}
        onBackToGames={() => {
          setGameState(GAME_STATES.GAME_BROWSER);
          setGameId(null);
        }}
        additionalData={{ questions: quizQuestions, questionAnswers }}
      />
    );
  }

  return null;
}
