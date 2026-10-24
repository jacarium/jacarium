import React, { useState, useEffect } from 'react';
import { X, Users, Play, Crown, Trophy, Home } from 'lucide-react';
import {
  sendTilesCreateLobby,
  sendTilesJoinLobby,
  sendTilesStart,
  sendTilesCellClick,
  sendTilesLeaveLobby,
  onTilesLobbyCreated,
  onTilesPlayerJoined,
  onTilesPlayerLeft,
  onTilesGameStarted,
  onTilesGameStateUpdate,
  onTilesGameEnded,
} from '../utils/cloudWebSocket';
import { useNotifications } from '../contexts/NotificationContext';

const GAME_STATES = {
  SETUP: 'setup',
  LOBBY: 'lobby',
  PLAYING: 'playing',
  FINISHED: 'finished',
};

const FloatingTiles = ({ onClose, currentMachineId, playerName }) => {
  const { addNotification } = useNotifications();
  const [gameState, setGameState] = useState(GAME_STATES.SETUP);
  const [lobbyId, setLobbyId] = useState('');
  const [players, setPlayers] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [gridSize, setGridSize] = useState(5);
  const [isSinglePlayer, setIsSinglePlayer] = useState(false);

  // Game state
  const [myGrid, setMyGrid] = useState([]);
  const [opponentGrid, setOpponentGrid] = useState([]);
  const [myMoves, setMyMoves] = useState(0);
  const [opponentMoves, setOpponentMoves] = useState(0);
  const [winner, setWinner] = useState(null);
  const [timeElapsed, setTimeElapsed] = useState(0);

  // Timer for elapsed time
  useEffect(() => {
    if (gameState === GAME_STATES.PLAYING) {
      const interval = setInterval(() => {
        setTimeElapsed(prev => prev + 1);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [gameState]);

  // Format time
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // WebSocket event listeners
  useEffect(() => {
    const unsubLobbyCreated = onTilesLobbyCreated((data) => {
      console.log('[Tiles] Lobby created:', data);
      setLobbyId(data.lobbyId);
      setPlayers(data.players || []);
      setIsHost(true);
      setGameState(GAME_STATES.LOBBY);
    });

    const unsubPlayerJoined = onTilesPlayerJoined((data) => {
      console.log('[Tiles] Player joined:', data);
      setPlayers(data.players || []);
    });

    const unsubPlayerLeft = onTilesPlayerLeft((data) => {
      console.log('[Tiles] Player left:', data);
      setPlayers(data.players || []);
    });

    const unsubGameStarted = onTilesGameStarted((data) => {
      console.log('[Tiles] Game started:', data);
      setMyGrid(data.myGrid);
      setOpponentGrid(data.opponentGrid);
      setMyMoves(0);
      setOpponentMoves(0);
      setTimeElapsed(0);
      setGameState(GAME_STATES.PLAYING);
    });

    const unsubGameStateUpdate = onTilesGameStateUpdate((data) => {
      console.log('[Tiles] Game state update:', data);
      setMyGrid(data.myGrid);
      setOpponentGrid(data.opponentGrid);
      setMyMoves(data.myMoves);
      setOpponentMoves(data.opponentMoves);
    });

    const unsubGameEnded = onTilesGameEnded((data) => {
      console.log('[Tiles] Game ended:', data);
      setWinner(data.winner);
      setGameState(GAME_STATES.FINISHED);
    });

    return () => {
      unsubLobbyCreated();
      unsubPlayerJoined();
      unsubPlayerLeft();
      unsubGameStarted();
      unsubGameStateUpdate();
      unsubGameEnded();
    };
  }, []);

  // Create lobby
  const handleCreateLobby = async () => {
    const success = await sendTilesCreateLobby(currentMachineId, playerName, gridSize, isSinglePlayer);
    if (!success) {
      addNotification({
        type: 'error',
        title: 'Lobby Creation Failed',
        message: 'Failed to create lobby'
      });
    }
  };

  // Join lobby
  const handleJoinLobby = async () => {
    if (!lobbyId.trim()) {
      addNotification({
        type: 'alert',
        title: 'Lobby ID Required',
        message: 'Please enter a lobby ID'
      });
      return;
    }
    const success = await sendTilesJoinLobby(lobbyId, currentMachineId, playerName);
    if (success) {
      setGameState(GAME_STATES.LOBBY);
    } else {
      addNotification({
        type: 'error',
        title: 'Join Failed',
        message: 'Failed to join lobby'
      });
    }
  };

  // Start game
  const handleStartGame = async () => {
    if (!isHost) return;
    await sendTilesStart(lobbyId);
  };

  // Handle cell click
  const handleCellClick = async (row, col) => {
    if (gameState !== GAME_STATES.PLAYING) return;
    await sendTilesCellClick(lobbyId, currentMachineId, row, col);
  };

  // Leave lobby
  const handleLeaveLobby = async () => {
    if (lobbyId) {
      await sendTilesLeaveLobby(lobbyId, currentMachineId);
    }
    onClose();
  };

  // Render grid
  const renderGrid = (grid, isMyGrid, moves) => {
    if (!grid || grid.length === 0) return null;

    return (
      <div className="flex flex-col items-center">
        <div className="mb-2 text-sm text-os-text-secondary">
          {isMyGrid ? 'Your Grid' : 'Opponent Grid'}
        </div>
        <div className="mb-2 text-os-text-primary font-bold">
          Moves: {moves}
        </div>
        <div
          className="inline-grid gap-1"
          style={{
            gridTemplateColumns: `repeat(${grid.length}, minmax(0, 1fr))`,
          }}
        >
          {grid.map((row, rowIndex) => (
            row.map((cell, colIndex) => (
              <button
                key={`${rowIndex}-${colIndex}`}
                onClick={() => isMyGrid && handleCellClick(rowIndex, colIndex)}
                className={`
                  w-12 h-12 rounded border-2 transition-all duration-200
                  ${cell
                    ? 'bg-blue-500 border-blue-600 shadow-lg shadow-blue-500/50'
                    : 'bg-gray-600 border-gray-500 dark:bg-gray-700 dark:border-gray-600'
                  }
                  ${isMyGrid ? 'hover:scale-105 active:scale-95 cursor-pointer' : 'cursor-default'}
                `}
                disabled={!isMyGrid}
              />
            ))
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-os-card rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-os-border">
          <div className="flex items-center gap-2">
            <Trophy className="text-os-blue" size={24} />
            <h2 className="text-xl font-bold text-os-text-primary">Tiles</h2>
          </div>
          <button
            onClick={handleLeaveLobby}
            className="p-2 hover:bg-os-hover rounded-sm transition-colors"
          >
            <X size={20} className="text-os-text-primary" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Setup Screen */}
          {gameState === GAME_STATES.SETUP && (
            <div className="space-y-6">
              <div className="text-center mb-6">
                <h3 className="text-lg font-semibold text-os-text-primary mb-2">Game Setup</h3>
                <p className="text-sm text-os-text-secondary">
                  Choose your game mode and grid size
                </p>
              </div>

              {/* Game Mode Selection */}
              <div className="space-y-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSinglePlayer}
                    onChange={(e) => setIsSinglePlayer(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span className="text-os-text-primary">Single Player Mode</span>
                </label>

                {/* Grid Size */}
                <div>
                  <label className="block text-sm font-medium text-os-text-primary mb-2">
                    Grid Size
                  </label>
                  <select
                    value={gridSize}
                    onChange={(e) => setGridSize(parseInt(e.target.value))}
                    className="w-full px-3 py-2 bg-os-bg border border-os-border rounded-sm text-os-text-primary"
                  >
                    <option value={3}>3×3 (Easy)</option>
                    <option value={4}>4×4 (Medium)</option>
                    <option value={5}>5×5 (Hard)</option>
                    <option value={6}>6×6 (Expert)</option>
                    <option value={7}>7×7 (Master)</option>
                  </select>
                </div>

                {/* Lobby ID for joining */}
                {!isSinglePlayer && (
                  <div>
                    <label className="block text-sm font-medium text-os-text-primary mb-2">
                      Join Existing Lobby (Optional)
                    </label>
                    <input
                      type="text"
                      value={lobbyId}
                      onChange={(e) => setLobbyId(e.target.value)}
                      placeholder="Enter lobby ID to join..."
                      className="w-full px-3 py-2 bg-os-bg border border-os-border rounded-sm text-os-text-primary"
                    />
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex gap-4">
                {lobbyId && !isSinglePlayer ? (
                  <button
                    onClick={handleJoinLobby}
                    className="btn btn-success flex-1 px-4 py-3 flex items-center justify-center gap-2"
                  >
                    <Users size={20} />
                    Join Lobby
                  </button>
                ) : (
                  <button
                    onClick={handleCreateLobby}
                    className="btn btn-primary flex-1 px-4 py-3 flex items-center justify-center gap-2"
                  >
                    <Play size={20} />
                    {isSinglePlayer ? 'Start Game' : 'Create Lobby'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Lobby Screen */}
          {gameState === GAME_STATES.LOBBY && (
            <div className="space-y-6">
              <div className="text-center">
                <h3 className="text-lg font-semibold text-os-text-primary mb-2">Lobby</h3>
                <p className="text-sm text-os-text-secondary mb-4">
                  Lobby ID: <span className="font-mono font-bold text-os-text-primary">{lobbyId}</span>
                </p>
              </div>

              {/* Players */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-os-text-primary">Players ({players.length}/2)</h4>
                {players.map((player) => (
                  <div
                    key={player.id}
                    className="flex items-center gap-2 p-3 bg-os-bg rounded-sm"
                  >
                    {player.id === players[0]?.id && <Crown size={16} className="text-yellow-500" />}
                    <span className="text-os-text-primary">{player.name}</span>
                    {player.id === currentMachineId && (
                      <span className="text-xs text-os-text-secondary">(You)</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Start Button */}
              {isHost && players.length === 2 && (
                <button
                  onClick={handleStartGame}
                  className="btn btn-success w-full px-4 py-3"
                >
                  Start Game
                </button>
              )}

              {!isHost && (
                <p className="text-sm text-os-text-secondary text-center">
                  Waiting for host to start the game...
                </p>
              )}
            </div>
          )}

          {/* Playing Screen */}
          {gameState === GAME_STATES.PLAYING && (
            <div className="space-y-6">
              {/* Timer */}
              <div className="text-center text-os-text-primary font-mono text-2xl">
                {formatTime(timeElapsed)}
              </div>

              {/* Instructions */}
              <p className="text-sm text-os-text-secondary text-center">
                Click tiles to toggle them and neighbors. Make all tiles the same to win!
              </p>

              {/* Grids */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {renderGrid(myGrid, true, myMoves)}
                {!isSinglePlayer && renderGrid(opponentGrid, false, opponentMoves)}
              </div>
            </div>
          )}

          {/* Finished Screen */}
          {gameState === GAME_STATES.FINISHED && (
            <div className="space-y-6 text-center">
              <div className="text-6xl mb-4">
                {winner === currentMachineId ? '🏆' : '😔'}
              </div>
              <h3 className="text-2xl font-bold text-os-text-primary">
                {winner === currentMachineId ? 'You Won!' : 'You Lost'}
              </h3>
              <div className="text-os-text-secondary">
                <p>Time: {formatTime(timeElapsed)}</p>
                <p>Moves: {myMoves}</p>
              </div>
              <button
                onClick={() => setGameState(GAME_STATES.SETUP)}
                className="btn btn-primary px-6 py-3 flex items-center justify-center gap-2 mx-auto"
              >
                <Home size={20} />
                New Game
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FloatingTiles;
