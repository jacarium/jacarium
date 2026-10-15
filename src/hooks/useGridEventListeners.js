/**
 * Custom hook for Grid mode WebSocket event listeners
 * Handles all Grid-related events: join, start, tile selection, buzzing, answers, sync, state updates
 */

import { useEffect } from 'react';
import {
  onGridJoin,
  onGridStart,
  onGridSelectTile,
  onGridBuzz,
  onGridAnswer,
  onGridEnd,
  onGridSyncPlayers,
  onGridRequestSync,
  onGridReturnToBoard,
  onGridStateUpdate,
  onGridTimerTick
} from '../utils/cloudWebSocket';
import { createJoinHandler } from '../utils/gameHelpers';
import { GAME_STATES, GRID_GAME_TIME, GRID_BUZZ_WINDOW, GRID_ANSWER_TIME } from '../constants/gameConstants';

export function useGridEventListeners({
  gameId,
  isHost,
  currentMachineId,
  gameState,
  players,
  gridState,
  setPlayers,
  setGameState,
  setGridState,
  setScoreHistory,
  setMyAnswer,
  sendGridSyncPlayers
}) {
  useEffect(() => {
    if (!gameId) return;

    // Player joined lobby
    const unsubGridJoin = onGridJoin(
      createJoinHandler(gameId, isHost, setPlayers, sendGridSyncPlayers)
    );

    // Game started
    const unsubGridStart = onGridStart((data) => {
      const { gameId: startGameId, board, selectedCategories, initialSelector } = data;
      if (startGameId !== gameId || isHost) return;

      console.log('[Grid] Game started by host');
      setGridState({
        board,
        currentTile: null,
        currentBuzzer: null,
        buzzerWindow: false,
        timeRemaining: GRID_BUZZ_WINDOW,
        attemptedPlayers: [],
        selector: initialSelector,
        showingAnswer: false,
        lastCorrectAnswerer: undefined,
        answeredTiles: [],
        selectedCategories,
        gameTimeRemaining: GRID_GAME_TIME
      });
      setGameState(GAME_STATES.GRID_BOARD);

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

    // Tile selected
    const unsubGridSelectTile = onGridSelectTile((data) => {
      const { gameId: tileGameId, playerId, tile } = data;
      if (tileGameId !== gameId || playerId === currentMachineId) return;

      console.log('[Grid] Tile selected:', tile);
      setGridState(prev => ({
        ...prev,
        currentTile: tile,
        attemptedPlayers: [],
        currentBuzzer: null,
        buzzerWindow: true,
        timeRemaining: GRID_BUZZ_WINDOW,
        showingAnswer: false
      }));
      setMyAnswer('');
      setGameState(GAME_STATES.GRID_QUESTION);
    });

    // Player buzzed in
    const unsubGridBuzz = onGridBuzz((data) => {
      const { gameId: buzzGameId, playerId } = data;
      if (buzzGameId !== gameId || playerId === currentMachineId) return;

      console.log('[Grid] Player buzzed:', playerId);

      // Close buzz window and give them the buzzer
      // If typing is in progress, pause it
      setGridState(prev => {
        let pauseAt = null;
        if (prev.typingInProgress && prev.typingStartTime) {
          const elapsed = Date.now() - prev.typingStartTime;
          const charIndex = elapsed < 0 ? 0 : Math.floor(elapsed / 50); // TYPING_SPEED_MS = 50
          const questionText = prev.currentTile?.question?.question || '';
          pauseAt = Math.min(charIndex, questionText.length);
          console.log('[Grid] Pausing typing at character', pauseAt);
        }

        return {
          ...prev,
          buzzerWindow: false,
          currentBuzzer: playerId,
          timeRemaining: GRID_ANSWER_TIME,
          typingInProgress: false,
          typingPausedAt: pauseAt !== null ? pauseAt : prev.typingPausedAt
        };
      });

      // Make sure we're in the question state
      if (gameState !== GAME_STATES.GRID_QUESTION) {
        setGameState(GAME_STATES.GRID_QUESTION);
      }
    });

    // Answer submitted
    const unsubGridAnswer = onGridAnswer((data) => {
      const { gameId: answerGameId, playerId, answer, correct, pointsEarned, tileInfo } = data;
      if (answerGameId !== gameId || playerId === currentMachineId) return;

      console.log('[Grid] Answer submitted:', { playerId, correct, pointsEarned, tileInfo });

      // Update player score
      setPlayers((prev) => {
        const updatedPlayers = prev.map(p =>
          p.id === playerId ? { ...p, score: p.score + pointsEarned } : p
        );

        // Update score history using the new scores (for both correct and incorrect)
        setScoreHistory(prevHistory => {
          const updated = { ...prevHistory };
          updatedPlayers.forEach(player => {
            updated[player.id] = [...(updated[player.id] || [0]), player.score];
          });
          return updated;
        });

        return updatedPlayers;
      });

      if (correct) {
        // Set selector to the player who answered correctly
        setGridState(prev => {
          // Mark tile as answered using tileInfo
          const updatedBoard = tileInfo
            ? prev.board.map(tile =>
                tile.categoryId === tileInfo.categoryId && tile.difficulty === tileInfo.difficulty
                  ? { ...tile, answered: true }
                  : tile
              )
            : prev.board;

          // Find the tile to add to answered tiles
          const answeredTile = tileInfo
            ? prev.board.find(t =>
                t.categoryId === tileInfo.categoryId && t.difficulty === tileInfo.difficulty
              )
            : null;

          return {
            ...prev,
            selector: playerId,
            board: updatedBoard,
            answeredTiles: answeredTile ? [...prev.answeredTiles, answeredTile.question] : prev.answeredTiles,
            currentBuzzer: null,
            showingAnswer: true
          };
        });

        // Update UI state if we're in question mode
        if (gameState === GAME_STATES.GRID_QUESTION) {
          setMyAnswer('');
        }
      } else {
        // Incorrect - add to attempted players and add to incorrect answers list
        setGridState(prev => {
          const playerName = players.find(p => p.id === playerId)?.name || playerId;
          return {
            ...prev,
            attemptedPlayers: [...prev.attemptedPlayers, playerId],
            currentBuzzer: null,
            incorrectAnswers: [...(prev.incorrectAnswers || []), { playerName, answer }]
          };
        });

        // Only update UI state if we're in question mode
        if (gameState === GAME_STATES.GRID_QUESTION) {
          const remainingPlayers = players.filter(p =>
            !gridState.attemptedPlayers.includes(p.id) && p.id !== playerId
          );

          if (remainingPlayers.length > 0) {
            console.log('[Grid] Opening new buzz window for remaining players, resuming typing if paused');
            setGridState(prev => {
              // If typing was paused, resume it
              if (prev.typingPausedAt !== null) {
                return {
                  ...prev,
                  buzzerWindow: true,
                  timeRemaining: GRID_BUZZ_WINDOW,
                  typingInProgress: true,
                  typingPausedAt: prev.typingPausedAt // Keep the pause point for resume
                };
              }
              return {
                ...prev,
                buzzerWindow: true,
                timeRemaining: GRID_BUZZ_WINDOW
              };
            });
          } else {
            // No one left, show answer and mark tile as answered
            setGridState(prev => {
              const updatedBoard = tileInfo
                ? prev.board.map(tile =>
                    tile.categoryId === tileInfo.categoryId && tile.difficulty === tileInfo.difficulty
                      ? { ...tile, answered: true }
                      : tile
                  )
                : prev.board;

              const answeredTile = tileInfo
                ? prev.board.find(t =>
                    t.categoryId === tileInfo.categoryId && t.difficulty === tileInfo.difficulty
                  )
                : null;

              return {
                ...prev,
                showingAnswer: true,
                board: updatedBoard,
                answeredTiles: answeredTile ? [...prev.answeredTiles, answeredTile.question] : prev.answeredTiles
              };
            });
          }
        }
      }
    });

    // Game ended
    const unsubGridEnd = onGridEnd((data) => {
      const { gameId: endGameId } = data;
      if (endGameId !== gameId || isHost) return;

      console.log('[Grid] Game ended');
      setGameState(GAME_STATES.RESULTS);
    });

    // Player list sync (from host)
    const unsubGridSyncPlayers = onGridSyncPlayers((data) => {
      const { gameId: syncGameId, players: syncedPlayers } = data;
      if (syncGameId !== gameId) return;

      console.log('[Grid] Syncing player list:', syncedPlayers.length, 'players');

      // Ensure all players have scores, connected flag, and clientType (default to 0, true, and inferred if missing)
      const playersWithScores = syncedPlayers.map(p => {
        // Infer clientType from player ID if missing (web players have IDs starting with "web-")
        const existingPlayer = players.find(existing => existing.id === p.id);
        let clientType = p.clientType || existingPlayer?.clientType;
        if (!clientType) {
          clientType = p.id.startsWith('web-') ? 'web' : 'app';
        }

        return {
          ...p,
          score: p.score ?? 0,
          connected: p.connected !== false, // Default to true unless explicitly false
          clientType
        };
      });

      // Log player connection states
      const playerStates = playersWithScores.map(p => `${p.name}:${p.connected ? 'C' : 'DC'}:${p.clientType}`).join(', ');
      console.log('[Grid] grid-sync-players updating players:', playerStates);

      setPlayers(playersWithScores);
    });

    // Sync request handler - Grid mode is server-authoritative
    // Server handles sync requests directly by sending grid-state-update
    const unsubGridRequestSync = onGridRequestSync(() => {
      // No-op: Server handles this authoritatively
      // Keeping subscription active to clean up properly
    });

    // Return to board (broadcast sync)
    const unsubGridReturnToBoard = onGridReturnToBoard((data) => {
      const { gameId: returnGameId } = data;
      if (returnGameId !== gameId) return;

      console.log('[Grid] Returning to board (broadcast sync)');
      setGameState(GAME_STATES.GRID_BOARD);
      setGridState(prev => ({
        ...prev,
        currentTile: null,
        showingAnswer: false,
        currentBuzzer: null
      }));
      setMyAnswer('');
    });

    // Listen to authoritative state updates from server
    const unsubGridStateUpdate = onGridStateUpdate((data) => {
      const { gameId: updateGameId, state, board, players: serverPlayers, scoreHistory: serverScoreHistory,
              currentTile, currentBuzzer, buzzerWindow, attemptedPlayers, lastCorrectAnswerer, selector,
              gameTimeRemaining, questionTimeRemaining, answeredTiles, typingInProgress, typingStartTime,
              typingDuration, typingPausedAt, serverTime, incorrectAnswers } = data;

      if (updateGameId !== gameId) return;

      console.log('[Grid] State update from server:', state);

      // Update all state from server (use prev to avoid unnecessary re-renders)
      setGridState(prev => {
        // Clear answer input if we lost the buzzer (timer expired or answered)
        if (prev.currentBuzzer === currentMachineId && currentBuzzer !== currentMachineId) {
          setMyAnswer('');
        }

        return {
          ...prev,
          board,
          currentTile,
          currentBuzzer,
          buzzerWindow,
          timeRemaining: questionTimeRemaining,
          attemptedPlayers,
          selector,
          showingAnswer: state === 'showing-answer',
          lastCorrectAnswerer,
          answeredTiles,
          gameTimeRemaining,
          typingInProgress: typingInProgress || false,
          typingStartTime,
          typingDuration: typingDuration || 0,
          typingPausedAt,
          serverTime: serverTime || null,
          incorrectAnswers: incorrectAnswers || []
        };
      });
      // Ensure all players have scores (default to 0 if missing)
      const playersWithScores = serverPlayers.map(p => ({
        ...p,
        score: p.score ?? 0
      }));
      setPlayers(playersWithScores);
      setScoreHistory(serverScoreHistory);

      // Update game state based on server state (only if actually changing)
      const targetGameState =
        state === 'board' ? GAME_STATES.GRID_BOARD :
        state === 'question' ? GAME_STATES.GRID_QUESTION :
        state === 'showing-answer' ? GAME_STATES.GRID_QUESTION :
        state === 'ended' ? GAME_STATES.RESULTS :
        null;

      if (targetGameState && gameState !== targetGameState) {
        setGameState(targetGameState);
      }
    });

    // Lightweight per-second countdown ticks. The server no longer re-sends
    // the full game payload from its 1s timer - only the countdown numbers
    // arrive here, and they are merged into the existing local state.
    const unsubGridTimerTick = onGridTimerTick((data) => {
      const { gameId: tickGameId, gameTimeRemaining, questionTimeRemaining, serverTime } = data;
      if (tickGameId !== gameId) return;

      setGridState(prev => ({
        ...prev,
        gameTimeRemaining,
        timeRemaining: questionTimeRemaining,
        serverTime: serverTime ?? prev.serverTime
      }));
    });

    return () => {
      unsubGridJoin();
      unsubGridStart();
      unsubGridSelectTile();
      unsubGridBuzz();
      unsubGridAnswer();
      unsubGridEnd();
      unsubGridSyncPlayers();
      unsubGridRequestSync();
      unsubGridReturnToBoard();
      unsubGridStateUpdate();
      unsubGridTimerTick();
    };
    // Subscription effect intentionally keyed on game identity/state; the
    // set* callbacks are parent useState setters (stable) and send* helpers
    // capture the same values already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, isHost, currentMachineId, gameState, players, gridState.attemptedPlayers]);
}
