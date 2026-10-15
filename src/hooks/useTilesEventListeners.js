/**
 * Custom hook for Tiles mode WebSocket event listeners
 * Handles all Tiles-related events: lobby creation, player join/leave, game start, state updates, game end
 */

import { useEffect } from 'react';
import {
  onTilesLobbyCreated,
  onTilesPlayerJoined,
  onTilesPlayerLeft,
  onTilesGameStarted,
  onTilesGameStateUpdate,
  onTilesGameEnded
} from '../utils/cloudWebSocket';
import { GAME_STATES } from '../constants/gameConstants';

export function useTilesEventListeners({
  gameId,
  currentMachineId,
  setPlayers,
  setGameState,
  setTilesState,
  setScoreHistory,
  setLobbyName,
}) {
  useEffect(() => {
    if (!gameId) return;

    // Lobby created
    const unsubLobbyCreated = onTilesLobbyCreated((data) => {
      const { lobbyId, players } = data;
      if (lobbyId !== gameId) return;

      console.log('[Tiles] Lobby created:', data);
      setPlayers(players);
    });

    // Player joined
    const unsubPlayerJoined = onTilesPlayerJoined((data) => {
      const { lobbyId, players, lobbyName } = data;
      if (lobbyId !== gameId) return;

      console.log('[Tiles] Player joined:', data);
      console.log('[Tiles] Players array:', players);
      players.forEach(p => console.log(`  - ${p.name}: status=${p.status}, ready=${p.ready}, connected=${p.connected}`));
      setPlayers(players);
      if (lobbyName && setLobbyName) {
        setLobbyName(lobbyName);
      }
    });

    // Player left
    const unsubPlayerLeft = onTilesPlayerLeft((data) => {
      const { lobbyId, players } = data;
      if (lobbyId !== gameId) return;

      console.log('[Tiles] Player left:', data);
      setPlayers(players);
    });

    // Game started
    const unsubGameStarted = onTilesGameStarted((data) => {
      const { lobbyId, myGrid, opponentStates } = data;
      if (lobbyId !== gameId) return;

      console.log('[Tiles] Game started:', data);

      setTilesState(prev => ({
        ...prev,
        myGrid,
        myMoves: 0,
        opponentStates: opponentStates || [],
        timeElapsed: 0,
        winner: null,
      }));

      setGameState(GAME_STATES.PLAYING);
    });

    // Game state update
    const unsubGameStateUpdate = onTilesGameStateUpdate((data) => {
      const { lobbyId, myGrid, myMoves, mySolved, opponentStates } = data;
      if (lobbyId !== gameId) return;

      console.log('[Tiles] Game state update:', data);

      setTilesState(prev => ({
        ...prev,
        myGrid,
        myMoves,
        mySolved: mySolved || false,
        opponentStates: opponentStates || [],
      }));
    });

    // Game ended
    const unsubGameEnded = onTilesGameEnded((data) => {
      const { lobbyId, winner, playerResults } = data;
      if (lobbyId !== gameId) return;

      console.log('[Tiles] Game ended:', data);

      // Find my result
      const myResult = playerResults.find(p => p.id === currentMachineId);

      setTilesState(prev => ({
        ...prev,
        winner,
        myMoves: myResult?.moves || 0,
        playerResults,
      }));

      // Update scoreHistory with final move counts for each player
      // For Tiles, "score" is actually move count (lower is better)
      if (setScoreHistory) {
        const history = {};
        playerResults.forEach(p => {
          history[p.id] = [p.moves];
        });
        setScoreHistory(history);
      }

      setGameState(GAME_STATES.RESULTS);
    });

    return () => {
      unsubLobbyCreated();
      unsubPlayerJoined();
      unsubPlayerLeft();
      unsubGameStarted();
      unsubGameStateUpdate();
      unsubGameEnded();
    };
    // Subscription effect intentionally keyed on game identity/state; the
    // set* callbacks are parent useState setters (stable) and send* helpers
    // capture the same values already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, currentMachineId, setPlayers, setGameState, setTilesState, setScoreHistory]);
}
