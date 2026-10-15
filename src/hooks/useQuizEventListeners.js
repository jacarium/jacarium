/**
 * Custom hook for Quiz mode WebSocket event listeners
 * Handles all Quiz-related events: join, start, guess, next, end, sync, anti-cheat
 */

import { useEffect } from 'react';
import {
  onQuizJoin,
  onQuizStart,
  onQuizNextQuestion,
  onQuizEnd,
  onQuizSyncPlayers,
  onQuizAntiCheatTrigger,
  onQuizStateUpdate,
  onQuizTimerTick
} from '../utils/cloudWebSocket';
import { createJoinHandler } from '../utils/gameHelpers';
import { GAME_STATES, QUESTION_TIME_SECONDS } from '../constants/gameConstants';

export function useQuizEventListeners({
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
  setHintsRevealed,
  setTimeRemaining,
  setQuestionAnswers,
  setMyAnswer,
  setHasAnsweredCurrentQuestion,
  setShowingAnswer,
  setRevealedAnswer,
  setScoreHistory,
  setLobbyName,
  sendQuizSyncPlayers
}) {
  useEffect(() => {
    if (!gameId) return;

    // Check if we're in active quiz based on game state
    const isActiveQuiz = gameState === 'playing' || gameState === 'results';

    // Wrapper for sendQuizSyncPlayers that only works during lobby phase
    // During active quiz, server is authoritative and handles player sync via quiz-state-update
    const syncPlayersIfLobby = async (gId, playerList) => {
      // If quiz is active, don't sync - server is authoritative
      if (isActiveQuiz) {
        console.log('[Quiz] Skipping player sync - server is authoritative during active quiz');
        return;
      }
      // In lobby - sync normally
      return sendQuizSyncPlayers(gId, playerList);
    };

    // Custom join handler that doesn't update local state during active quiz
    const handleQuizJoin = (data) => {
      const { gameId: joinGameId } = data;
      if (joinGameId !== gameId) return;

      // During active quiz, ignore join events - server will send authoritative state via quiz-state-update
      if (isActiveQuiz) {
        console.log('[Quiz] Ignoring join event during active quiz - waiting for server state update');
        return;
      }

      // In lobby - use normal join handler
      createJoinHandler(gameId, isHost, setPlayers, syncPlayersIfLobby)(data);
    };

    // Player joined lobby
    const unsubJoin = onQuizJoin(handleQuizJoin);

    // Game started
    const unsubStart = onQuizStart((data) => {
      const { gameId: startGameId, questions } = data;
      if (startGameId !== gameId || isHost) return;

      console.log('[Quiz] Game started by host with', questions?.length, 'questions');

      // Set questions received from host
      if (questions && questions.length > 0) {
        setQuizQuestions(questions);

        // Infer quiz type from questions category to fix the title display
        // Check if it's a known quiz type based on the category
        const firstCategory = questions[0]?.category;
        if (firstCategory) {
          const matchingQuizType = QUIZ_TYPES.find(qt =>
            qt.title.toLowerCase() === firstCategory.toLowerCase() ||
            qt.id === firstCategory.toLowerCase().replace(/\s+/g, '-')
          );
          if (matchingQuizType) {
            setSelectedQuizType(matchingQuizType.id);
          } else {
            // Unknown quiz type (probably AI generated) - use the category as-is
            setSelectedQuizType('ai-generated');
          }
        }
      }

      setGameState(GAME_STATES.PLAYING);
      setCurrentQuestionIndex(0);
      setHintsRevealed(0);
      setTimeRemaining(QUESTION_TIME_SECONDS);
      setQuestionAnswers([]);
      setMyAnswer('');
      setHasAnsweredCurrentQuestion(false);
      setShowingAnswer(false);
      setRevealedAnswer('');  // Clear any previous revealed answer

      // Initialize score history for all players (starting at 0)
      setPlayers(prev => {
        const initialHistory = {};
        prev.forEach(player => {
          initialHistory[player.id] = [0];
        });
        setScoreHistory(initialHistory);
        return prev;
      });
    });

    // Note: quiz-submit-guess is no longer used - server broadcasts quiz-state-update instead

    // Next question
    const unsubNext = onQuizNextQuestion((data) => {
      const { gameId: nextGameId, questionIndex } = data;
      if (nextGameId !== gameId || isHost) return;

      console.log('[Quiz] Moving to next question:', questionIndex);
      setCurrentQuestionIndex(questionIndex);
      setHintsRevealed(0); // Reset hints for each player on new question
      setTimeRemaining(QUESTION_TIME_SECONDS);
      setMyAnswer('');
      setHasAnsweredCurrentQuestion(false);
      setShowingAnswer(false);
    });

    // Quiz ended
    const unsubEnd = onQuizEnd((data) => {
      const { gameId: endGameId } = data;
      if (endGameId !== gameId || isHost) return;

      console.log('[Quiz] Quiz ended');
      setGameState(GAME_STATES.RESULTS);
    });

    // Player list sync (from host)
    const unsubSync = onQuizSyncPlayers((data) => {
      const { gameId: syncGameId, players: syncedPlayers, lobbyName } = data;
      if (syncGameId !== gameId) return;

      // During active quiz, ignore quiz-sync-players - only use quiz-state-update
      if (isActiveQuiz) {
        console.log('[Quiz] Ignoring quiz-sync-players during active quiz - server is authoritative');
        return;
      }

      console.log('[Quiz] Syncing player list:', syncedPlayers.length, 'players');

      // Update lobby name if provided
      if (lobbyName) {
        setLobbyName(lobbyName);
      }

      // Ensure all players have scores (default to 0 if missing)
      // Preserve local antiCheat flags, clientType, and connected state when updating from server
      const playersWithScores = syncedPlayers.map(p => {
        const existingPlayer = players.find(existing => existing.id === p.id);

        // Infer clientType from player ID if missing (web players have IDs starting with "web-")
        let clientType = p.clientType || existingPlayer?.clientType;
        if (!clientType) {
          clientType = p.id.startsWith('web-') ? 'web' : 'app';
        }

        return {
          ...p,
          score: p.score ?? 0,
          antiCheat: existingPlayer?.antiCheat || p.antiCheat || false,
          clientType,
          // Preserve connected state - if server doesn't send it, use existing or default to true
          connected: p.connected !== undefined ? p.connected : (existingPlayer?.connected ?? true)
        };
      });

      // Log player connection states and clientTypes
      const playerStates = playersWithScores.map(p => `${p.name}:${p.connected !== false ? 'C' : 'D'}:${p.clientType || 'unknown'}`).join(', ');
      console.log('[Quiz] quiz-sync-players updating players:', playerStates);

      setPlayers(playersWithScores);
    });

    // Anti-cheat trigger
    const unsubAntiCheat = onQuizAntiCheatTrigger((data) => {
      const { gameId: acGameId, playerId } = data;
      if (acGameId !== gameId) return;

      console.log('[Quiz] Anti-cheat triggered for player:', playerId);
      setPlayers((prev) => prev.map(p =>
        p.id === playerId ? { ...p, antiCheat: true } : p
      ));
    });

    // Sync request (someone reconnecting asks for current state)
    // Listen to authoritative state updates from server
    const unsubStateUpdate = onQuizStateUpdate((data) => {
      const { gameId: updateGameId, state, currentQuestionIndex: qIdx, timeRemaining,
              players: serverPlayers, scoreHistory: serverScoreHistory,
              questionAnswers, questions, lobbyName, currentQuestionAnswer } = data;

      if (updateGameId !== gameId) return;

      console.log('[Quiz] State update from server:', state);

      // Update lobby name if provided
      if (lobbyName) {
        setLobbyName(lobbyName);
      }

      // Update all state from server
      // Check if question changed - if so, reset ALL local state for new question
      const questionChanged = qIdx !== currentQuestionIndex;

      if (questionChanged) {
        console.log('[Quiz] Question changed, resetting local state');
        setHintsRevealed(0);
        setRevealedAnswer('');  // Clear revealed answer for new question
        setShowingAnswer(false);  // Reset showing answer state
        setMyAnswer('');  // Clear answer input
        setHasAnsweredCurrentQuestion(false);  // Re-enable answering
      }
      // Note: We don't sync hintsRevealed from server because hints are per-player local state

      // Only process currentQuestionAnswer if server explicitly sent it (when revealing)
      // Server omits this field during normal gameplay, only includes it when revealing
      if ('currentQuestionAnswer' in data && currentQuestionAnswer && !questionChanged) {
        console.log('[Quiz] Server revealed answer:', currentQuestionAnswer);
        setRevealedAnswer(currentQuestionAnswer);
        setShowingAnswer(true);
      }

      setCurrentQuestionIndex(qIdx);
      setTimeRemaining(timeRemaining);
      setQuestionAnswers(questionAnswers);

      // Ensure all players have scores
      // Preserve local antiCheat flags and connected state when updating from server
      const playersWithScores = serverPlayers.map(p => {
        const existingPlayer = players.find(existing => existing.id === p.id);
        return {
          ...p,
          score: p.score ?? 0,
          antiCheat: existingPlayer?.antiCheat || p.antiCheat || false,
          // Preserve connected state - if server doesn't send it, use existing or default to true
          connected: p.connected !== undefined ? p.connected : (existingPlayer?.connected ?? true)
        };
      });

      // Log player connection states
      const playerStates = playersWithScores.map(p => `${p.name}:${p.connected !== false ? 'C' : 'D'}`).join(', ');
      console.log('[Quiz] Updating players from server:', playerStates);

      setPlayers(playersWithScores);
      setScoreHistory(serverScoreHistory);

      // Update questions if not already set OR if quiz ended (server sends full questions with answers)
      if (questions && questions.length > 0) {
        if (!quizQuestions || quizQuestions.length === 0) {
          setQuizQuestions(questions);

          // Infer quiz type from questions
          const firstCategory = questions[0]?.category;
          if (firstCategory) {
            const matchingQuizType = QUIZ_TYPES.find(qt =>
              qt.title.toLowerCase() === firstCategory.toLowerCase() ||
              qt.id === firstCategory.toLowerCase().replace(/\s+/g, '-')
            );
            if (matchingQuizType) {
              setSelectedQuizType(matchingQuizType.id);
            } else {
              setSelectedQuizType('ai-generated');
            }
          }
        } else if (state === 'ended' && questions[0]?.answer) {
          // Quiz ended and we received full questions with answers - update them
          console.log('[Quiz] Quiz ended, updating questions with answers for results screen');
          setQuizQuestions(questions);
        }
      }

      // Update game state based on server state
      if (state === 'playing') {
        setGameState(GAME_STATES.PLAYING);
      } else if (state === 'ended') {
        setGameState(GAME_STATES.RESULTS);
      }
    });

    // Lightweight per-second countdown ticks. The server no longer re-sends
    // the full quiz payload from its 1s timer - only timeRemaining arrives
    // here and is merged into local state.
    const unsubTimerTick = onQuizTimerTick((data) => {
      if (data.gameId !== gameId) return;
      setTimeRemaining(data.timeRemaining);
    });

    return () => {
      unsubJoin();
      unsubStart();
      unsubNext();
      unsubEnd();
      unsubSync();
      unsubAntiCheat();
      unsubStateUpdate();
      unsubTimerTick();
    };
    // Subscription effect intentionally keyed on game identity/state; the
    // set* callbacks are parent useState setters (stable) and send* helpers
    // capture the same values already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, isHost, currentMachineId, QUIZ_TYPES, players, quizQuestions, currentQuestionIndex, hintsRevealed, timeRemaining, questionAnswers, scoreHistory, gameState]);
}
