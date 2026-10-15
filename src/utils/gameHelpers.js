/**
 * Game helper utilities for Quiz and Grid modes
 * Shared logic for player management and scoring
 */

/**
 * Update a player's score and score history
 * Returns the new score for the player
 */
export function updatePlayerScore(playerId, pointsEarned, setPlayers, setScoreHistory) {
  let newScore = 0;

  setPlayers(prev => prev.map(p => {
    if (p.id === playerId) {
      newScore = p.score + pointsEarned;
      return { ...p, score: newScore };
    }
    return p;
  }));

  setScoreHistory(prev => ({
    ...prev,
    [playerId]: [...(prev[playerId] || [0]), newScore]
  }));

  return newScore;
}

/**
 * Create a join handler for Quiz or Grid mode
 * Handles both new players joining, updating existing pending players, and reconnections
 */
export function createJoinHandler(gameId, isHost, setPlayers, syncPlayersFn) {
  return (data) => {
    const { gameId: joinGameId, playerId, playerName, clientType } = data;
    if (joinGameId !== gameId) return;

    setPlayers((prev) => {
      const existing = prev.find(p => p.id === playerId);
      const wasDisconnected = existing && existing.connected === false;

      if (wasDisconnected) {
        console.log(`[Game] Player reconnected: ${playerName} (${clientType || 'app'})`);
      } else {
        console.log(`[Game] Player joined: ${playerName} (${clientType || 'app'})`);
      }

      const newPlayers = existing
        ? prev.map(p => p.id === playerId
            ? {
                ...p,
                status: 'ready',
                ready: true,
                clientType: clientType || 'app',
                connected: true, // Mark as reconnected (or keep connected if already)
                score: p.score ?? 0 // Ensure score is never undefined
              }
            : p)
        : [...prev, {
            id: playerId,
            name: playerName,
            score: 0,
            ready: true,
            status: 'ready',
            clientType: clientType || 'app',
            connected: true // New players start as connected
          }];

      if (isHost) {
        syncPlayersFn(gameId, newPlayers).catch(err =>
          console.error('[Game] Failed to sync players:', err)
        );
      }

      return newPlayers;
    });
  };
}
