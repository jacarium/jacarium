import { useState, useEffect } from 'react';
import { Play, Server, X, Flag } from 'lucide-react';
import { GAME_STATES } from '../../constants/gameConstants';
import { useTilesEventListeners } from '../../hooks/useTilesEventListeners';
import {
  sendTilesCreateLobby,
  sendTilesStart,
  sendTilesCellClick,
  sendLobbyNameUpdate,
  onLobbyNameUpdate,
  sendTilesJoinLobby,
  sendTilesLeaveLobby,
  sendTilesGiveUp,
  fetchAvailableGames
} from '../../utils/cloudWebSocket';
import GameLobby from '../game-shared/GameLobby';
import GameResults from '../game-shared/GameResults';
import InviteModal from '../game-shared/InviteModal';
import GameBrowser from '../game-shared/GameBrowser';
import ShareLinkModal from '../game-shared/ShareLinkModal';
import ConfirmationModal from '../common/modals/ConfirmationModal';
import { useConfirmation } from '../../hooks/useConfirmation';
import { useNotifications } from '../../contexts/NotificationContext';
import { getCentralServerUrl } from '../../utils/cloudCentralSync';
import { notifyCentralUnavailable } from '../../utils/centralAvailability';
import { useDisplayName } from '../../hooks/useDisplayName';

/**
 * TilesGameMode - Complete Tiles game mode implementation
 * Self-contained component for the Tiles puzzle game
 *
 * @param {Object} props
 * @param {Function} props.onBack - Callback to return to mode selection
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {boolean} props.isCentralServerConnected - Connection status
 * @param {Object} props.pendingChallenge - Challenge details if joining via invite
 * @param {Function} props.onChallengeHandled - Callback when challenge has been handled
 */
export default function TilesGameMode({ onBack, currentMachineId, isCentralServerConnected, pendingChallenge, onChallengeHandled }) {
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
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showShareLinkModal, setShowShareLinkModal] = useState(false);
  const [availableGames, setAvailableGames] = useState([]);

  // Tiles-specific state
  const [tilesState, setTilesState] = useState({
    myGrid: [],
    myMoves: 0,
    mySolved: false,    // True when current player solved the puzzle
    opponentStates: [], // Array of {id, name, moves, solved, grid}
    playerResults: [],  // Final results when game ends
    gridSize: 5,
    winner: null,
    timeElapsed: 0,
    gaveUp: false,      // True when current player gave up
  });

  // Event listeners for multiplayer
  useTilesEventListeners({
    gameId,
    currentMachineId,
    setPlayers,
    setGameState,
    setTilesState,
    setScoreHistory,
    setLobbyName,
  });

  // Timer for elapsed time
  useEffect(() => {
    if (gameState !== GAME_STATES.PLAYING) return;

    const interval = setInterval(() => {
      setTilesState(prev => ({
        ...prev,
        timeElapsed: prev.timeElapsed + 1,
      }));
    }, 1000);

    return () => clearInterval(interval);
  }, [gameState]);

  // Available games polling (for game browser)
  useEffect(() => {
    if (gameState !== GAME_STATES.GAME_BROWSER || !currentMachineId || !isCentralServerConnected) return;

    const refreshGames = async () => {
      try {
        const games = await fetchAvailableGames(currentMachineId);
        console.log('[TilesGameMode] Fetched games:', games);
        console.log('[TilesGameMode] Tiles games:', games.filter(g => g.mode === 'tiles'));
        setAvailableGames(games);
      } catch (error) {
        console.error('[TilesGameMode] Failed to fetch available games:', error);
      }
    };

    refreshGames();
    const interval = setInterval(refreshGames, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, [gameState, currentMachineId, isCentralServerConnected]);

  // Handle pending challenge (joining via team chat invite)
  useEffect(() => {
    if (!pendingChallenge || !currentMachineId) return;

    const { gameId: acceptedGameId } = pendingChallenge;

    // Validate it's a Tiles challenge
    if (!acceptedGameId || !acceptedGameId.startsWith('tiles-')) {
      console.log('[Tiles] Ignoring non-Tiles challenge');
      return;
    }

    console.log('[Tiles] Accepting challenge for game:', acceptedGameId);

    // Join the lobby
    const playerName = selfName();
    sendTilesJoinLobby(acceptedGameId, currentMachineId, playerName)
      .then(() => {
        setGameId(acceptedGameId);
        setIsHost(false);
        setGameState(GAME_STATES.LOBBY);

        // Mark challenge as handled
        if (onChallengeHandled) {
          onChallengeHandled();
        }
      })
      .catch(error => {
        console.error('[Tiles] Failed to join lobby:', error);
      });
    // selfName is read once, when the accepted challenge is joined; it is a plain function remade on every
    // render and changes with the display name, and a name change must not join the lobby again
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selfName: read at join time only (see above)
  }, [pendingChallenge, currentMachineId, onChallengeHandled]);

  // Lobby name update listener
  useEffect(() => {
    if (!gameId) return;

    const unsubLobbyName = onLobbyNameUpdate((data) => {
      const { gameId: updateGameId, lobbyName: newName } = data;
      if (updateGameId !== gameId) return;

      console.log('[Tiles Lobby] Name updated to:', newName);
      setLobbyName(newName);
    });

    return () => {
      unsubLobbyName();
    };
  }, [gameId]);

  // Handle FloatingQuiz window closing
  useEffect(() => {
    const handleWindowClosing = () => {
      // Notify server we're leaving the game (only for multiplayer in lobby or playing)
      if (gameId && currentMachineId && !isSinglePlayer && (gameState === GAME_STATES.LOBBY || gameState === GAME_STATES.PLAYING)) {
        console.log('[TilesGameMode] Window closing, notifying server of disconnect');
        sendTilesLeaveLobby(gameId, currentMachineId).catch(err =>
          console.error('[TilesGameMode] Failed to notify server of exit:', err)
        );
      }
    };

    window.addEventListener('floatingQuizClosing', handleWindowClosing);
    return () => window.removeEventListener('floatingQuizClosing', handleWindowClosing);
  }, [gameId, currentMachineId, isSinglePlayer, gameState]);

  // Notify the server we're leaving the current multiplayer game/lobby.
  // Needed on every explicit exit path (quit X button, lobby back button):
  // unlike closing the floating window (which fires 'floatingQuizClosing'),
  // these paths fire no event and the app's shared socket stays connected,
  // so without tiles-leave-lobby the server would keep this player marked
  // connected and the abandoned game listed under "Running Games" forever.
  function notifyServerLeaving() {
    if (gameId && currentMachineId && !isSinglePlayer) {
      sendTilesLeaveLobby(gameId, currentMachineId).catch(err =>
        console.error('[TilesGameMode] Failed to notify server of exit:', err)
      );
    }
  }

  // Quit an in-progress game via the X button (back to mode selection)
  function quitToModeSelect() {
    notifyServerLeaving();
    onBack();
  }

  // Helper function to toggle a tile and its neighbors
  function toggleTilesCellLocal(grid, row, col) {
    const directions = [
      [0, 0],   // self
      [-1, 0],  // up
      [1, 0],   // down
      [0, -1],  // left
      [0, 1],   // right
    ];

    directions.forEach(([dr, dc]) => {
      const newRow = row + dr;
      const newCol = col + dc;

      if (newRow >= 0 && newRow < grid.length && newCol >= 0 && newCol < grid.length) {
        grid[newRow][newCol] = !grid[newRow][newCol];
      }
    });
  }

  // Handle cell click
  async function handleTilesCellClick(row, col) {
    if (!gameId || gameState !== GAME_STATES.PLAYING) return;

    if (isSinglePlayer) {
      // Single player: update local state
      const newGrid = tilesState.myGrid.map(r => [...r]);
      toggleTilesCellLocal(newGrid, row, col);

      const newMoves = tilesState.myMoves + 1;

      // Check if won (all tiles same state)
      const allOff = newGrid.every(r => r.every(cell => !cell));
      const allOn = newGrid.every(r => r.every(cell => cell));
      const isWon = allOff || allOn;

      setTilesState(prev => ({
        ...prev,
        myGrid: newGrid,
        myMoves: newMoves,
        winner: isWon ? currentMachineId : null,
      }));

      if (isWon) {
        // Populate players and scoreHistory for single player results
        const playerName = selfName();
        setPlayers([{
          id: currentMachineId,
          name: playerName,
          score: newMoves,
          ready: true,
          status: 'ready',
          clientType: 'app'
        }]);
        setScoreHistory({ [currentMachineId]: [newMoves] });

        setGameState(GAME_STATES.RESULTS);
        console.log(`[Tiles] Single player won in ${newMoves} moves!`);
      }
    } else {
      // Multiplayer: send to server
      try {
        await sendTilesCellClick(gameId, currentMachineId, row, col);
        // Server will broadcast state update to all clients
      } catch (error) {
        console.error('[Tiles] Failed to click cell:', error);
      }
    }
  }

  // Start game (multiplayer only - host action)
  async function startTilesGame() {
    if (!isHost || !gameId) return;

    try {
      await sendTilesStart(gameId);
      // Server will broadcast game started event
    } catch (error) {
      console.error('[Tiles] Failed to start game:', error);
    }
  }

  // Share web link
  function shareTilesLink() {
    if (!gameId) return;

    const centralServerUrl = getCentralServerUrl();

    if (!centralServerUrl) {
      notifyCentralUnavailable(addNotification, 'share a game link');
      return;
    }

    setShowShareLinkModal(true);
  }

  // Create game/lobby
  async function createGame() {
    console.log('[Tiles] Start button clicked', { isSinglePlayer, gridSize: tilesState.gridSize });
    const newGameId = `tiles-${Date.now()}`;
    const playerName = selfName();

    console.log('[Tiles] Setting up game', { newGameId, playerName });
    setGameId(newGameId);
    setIsHost(true);
    setHostId(currentMachineId);

    // Set default lobby name
    const defaultLobbyName = `${playerName}'s Tiles`;
    setLobbyName(defaultLobbyName);
    setPlayers([{
      id: currentMachineId,
      name: playerName,
      score: 0,
      ready: true,
      status: 'ready',
      clientType: 'app'
    }]);

    if (!isSinglePlayer) {
      // Multiplayer: Create lobby on server
      console.log('[Tiles] Creating multiplayer lobby');
      setGameState(GAME_STATES.LOBBY);
      try {
        await sendTilesCreateLobby(
          newGameId,
          currentMachineId,
          playerName,
          tilesState.gridSize,
          false
        );
        await sendLobbyNameUpdate(newGameId, defaultLobbyName);
        console.log('[Tiles] Multiplayer lobby created successfully');
      } catch (error) {
        console.error('[Tiles] Failed to create lobby:', error);
      }
    } else {
      // Single Player: Start game locally (offline)
      console.log('[Tiles] Starting single player game offline');

      // Initialize local grid
      const gridSize = tilesState.gridSize;
      const initGrid = () => {
        const grid = Array(gridSize).fill(null).map(() => Array(gridSize).fill(false));
        const randomClicks = Math.floor(Math.random() * 10) + 5;
        for (let i = 0; i < randomClicks; i++) {
          const row = Math.floor(Math.random() * gridSize);
          const col = Math.floor(Math.random() * gridSize);
          toggleTilesCellLocal(grid, row, col);
        }
        return grid;
      };

      const myGrid = initGrid();

      setTilesState(prev => ({
        ...prev,
        myGrid,
        opponentGrid: [],
        myMoves: 0,
        opponentMoves: 0,
        timeElapsed: 0,
        winner: null,
      }));

      setGameState(GAME_STATES.PLAYING);
      console.log('[Tiles] Single player game started locally');
    }
  }

  // Join existing game
  async function handleJoinGame(game) {
    const playerName = selfName();

    console.log('[Tiles] handleJoinGame called:', {
      gameId: game.gameId,
      canReconnect: game.canReconnect,
      hostId: game.hostId,
      currentMachineId,
      lobbyName: game.lobbyName
    });

    try {
      // Set gameId FIRST to ensure event listeners are registered before server responds
      setGameId(game.gameId);

      // Preserve host status if reconnecting to own game
      const wasHost = game.canReconnect && game.hostId === currentMachineId;
      setIsHost(wasHost);
      setHostId(game.hostId || null);

      // Set lobby name from game object
      if (game.lobbyName) {
        setLobbyName(game.lobbyName);
      }

      setGameState(GAME_STATES.LOBBY);

      // Send join request AFTER setting state
      await sendTilesJoinLobby(game.gameId, currentMachineId, playerName);

      console.log('[Tiles] Joined game:', game.gameId, wasHost ? '(as host)' : '', 'isHost:', wasHost);
    } catch (error) {
      console.error('[Tiles] Failed to join game:', error);
    }
  }

  // Render helpers
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const renderGrid = (grid, isMyGrid, playerName = null, moves = 0, solved = false, small = false) => {
    if (!grid || grid.length === 0) return null;

    const cellSize = small ? 'w-6 h-6' : 'w-12 h-12';
    const canClick = isMyGrid && !tilesState.gaveUp && !solved;

    return (
      <div className="flex flex-col items-center">
        <div className={`mb-2 ${small ? 'text-xs' : 'text-sm'} font-medium text-os-text-secondary`}>
          {isMyGrid ? 'Your Grid' : (playerName || 'Opponent Grid')}
        </div>
        <div className={`mb-2 text-os-text font-bold ${small ? 'text-xs' : 'text-sm'}`}>
          Moves: {moves === Infinity ? '∞' : moves}
          {solved && <span className="ml-2 text-green-500">✓ Solved!</span>}
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
                onClick={() => canClick && handleTilesCellClick(rowIndex, colIndex)}
                disabled={!canClick}
                className={`
                  ${cellSize} rounded ${small ? 'border' : 'border-2'} transition-all duration-200
                  ${!canClick ? 'opacity-50 cursor-not-allowed' : ''}
                  ${cell
                    ? 'bg-purple-500 border-purple-600 shadow-lg shadow-purple-500/50'
                    : 'bg-os-card-secondary border-os-border'
                  }
                  ${isMyGrid ? 'hover:scale-105 active:scale-95 cursor-pointer' : 'cursor-default opacity-75'}
                `}
                disabled={!isMyGrid}
              />
            ))
          ))}
        </div>
      </div>
    );
  };

  // Render game browser (active games)
  if (gameState === GAME_STATES.GAME_BROWSER) {
    return (
      <GameBrowser
        gameMode="tiles"
        modeTitle="Tiles"
        modeDescription="Lights Out puzzle - make all tiles the same"
        availableGames={availableGames}
        isCentralServerConnected={isCentralServerConnected}
        onBack={onBack}
        onCreateSinglePlayer={() => {
          console.log('[Tiles] Single Player from GameBrowser');
          setIsSinglePlayer(true);
          setGameState(GAME_STATES.QUIZ_TYPE_SELECTION);
        }}
        onCreateMultiplayer={() => {
          console.log('[Tiles] Multiplayer from GameBrowser');
          setIsSinglePlayer(false);
          setGameState(GAME_STATES.QUIZ_TYPE_SELECTION);
        }}
        onJoinGame={handleJoinGame}
      />
    );
  }

  // Render grid size selection
  if (gameState === GAME_STATES.QUIZ_TYPE_SELECTION) {
    const gridSizes = [
      { size: 3, label: 'Easy', description: '3×3 grid' },
      { size: 4, label: 'Medium', description: '4×4 grid' },
      { size: 5, label: 'Hard', description: '5×5 grid' },
      { size: 6, label: 'Expert', description: '6×6 grid' },
      { size: 7, label: 'Master', description: '7×7 grid' },
    ];

    return (
      <div className="flex-1 flex flex-col p-4 overflow-y-auto">
        {/* Header */}
        <div className="mb-4">
          <button
            onClick={() => setGameState(GAME_STATES.GAME_BROWSER)}
            className="text-xs text-os-text-secondary hover:text-os-text-primary mb-2"
          >
            ← Back
          </button>
          <h2 className="text-lg font-bold text-os-text-primary">Select Grid Size</h2>
          <p className="text-xs text-os-text-secondary">Choose your difficulty level</p>
        </div>

        {/* Grid Size Options */}
        <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border mb-4">
          <h3 className="text-sm font-semibold text-os-text-primary mb-3">Choose Difficulty</h3>
          <div className="grid grid-cols-2 gap-2">
            {gridSizes.map((option) => {
              const isSelected = tilesState.gridSize === option.size;
              return (
                <button
                  key={option.size}
                  onClick={() => {
                    setTilesState(prev => ({ ...prev, gridSize: option.size }));
                  }}
                  className={`px-2 py-2 text-left text-xs border rounded transition-all flex items-center gap-2 ${
                    isSelected
                      ? 'btn-brand-soft border-2'
                      : 'bg-os-card border-os-border hover:bg-os-card-secondary hover:border-os-border'
                  }`}
                >
                  <div className="flex-1">
                    <div className={`text-xs font-semibold ${isSelected ? 'text-purple-700 dark:text-purple-300' : 'text-os-text-primary'}`}>
                      {option.label}
                    </div>
                    <div className="text-[10px] text-os-text-secondary">{option.description}</div>
                  </div>
                  {isSelected && <span className="ml-auto text-xs">✓</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Start Button */}
        <button
          onClick={createGame}
          className="btn btn-brand w-full px-3 py-2 text-sm flex items-center justify-center gap-2"
        >
          <Play size={16} />
          {isSinglePlayer ? 'Start Tiles' : 'Create Lobby'}
        </button>
      </div>
    );
  }

  // Render lobby
  if (gameState === GAME_STATES.LOBBY) {
    const activePlayerCount = players.filter(p => p.status !== 'declined').length;
    const canStart = isSinglePlayer || (!isSinglePlayer && activePlayerCount >= 1);

    return (
      <>
        <GameLobby
          gameMode="tiles"
          gameId={gameId}
          lobbyName={lobbyName}
          players={players}
          isHost={isHost}
          hostId={hostId}
          isSinglePlayer={isSinglePlayer}
          currentMachineId={currentMachineId}
          canStart={canStart}
          onStart={startTilesGame}
          onInviteApp={() => setShowInviteModal(true)}
          onShareWebLink={shareTilesLink}
          onBack={() => {
            // Tell the server we're leaving so the lobby doesn't keep us
            // listed as a connected player forever
            notifyServerLeaving();
            setGameState(GAME_STATES.GAME_BROWSER);
            setGameId(null);
            setIsHost(false);
            setIsSinglePlayer(false);
          }}
          onUpdateLobbyName={(newName) => {
            setLobbyName(newName);
            if (gameId) {
              sendLobbyNameUpdate(gameId, newName);
            }
          }}
          metadata={`Tiles - ${tilesState.gridSize}×${tilesState.gridSize} grid`}
          startButtonText="Start Tiles"
        />
        <InviteModal
          isOpen={showInviteModal}
          onClose={() => setShowInviteModal(false)}
          gameId={gameId}
          gameMode="tiles"
          currentPlayers={players}
        />
        <ShareLinkModal
          isOpen={showShareLinkModal}
          onClose={() => setShowShareLinkModal(false)}
          gameUrl={`${getCentralServerUrl()}/tiles/${gameId}`}
          gameMode="tiles"
        />
      </>
    );
  }

  // Render playing state
  if (gameState === GAME_STATES.PLAYING) {
    const hasOpponents = tilesState.opponentStates && tilesState.opponentStates.length > 0;

    return (
      <div className="flex-1 flex flex-col p-4 overflow-y-auto">
        {/* Timer and Buttons */}
        <div className="flex justify-between items-center mb-4">
          {!isSinglePlayer && !tilesState.gaveUp && (
            <button
              onClick={async () => {
                if (await confirm({
                  title: 'Give Up?',
                  message: 'Are you sure you want to give up? You will be marked as Unranked.',
                  type: 'warning',
                  confirmLabel: 'Give Up',
                })) {
                  sendTilesGiveUp(gameId, currentMachineId);
                  setTilesState(prev => ({ ...prev, gaveUp: true, myMoves: Infinity }));
                }
              }}
              className="p-2 hover:bg-gray-500/10 text-gray-600 dark:text-gray-400 rounded-sm transition-colors"
              title="Give Up"
            >
              <Flag size={16} />
            </button>
          )}
          {!isSinglePlayer && tilesState.gaveUp && <div></div>}
          {isSinglePlayer && <div></div>}
          <div className="text-os-text font-mono text-2xl font-bold">
            {formatTime(tilesState.timeElapsed)}
          </div>
          <button
            onClick={quitToModeSelect}
            className="p-1 hover:bg-red-500/10 text-red-600 dark:text-red-400 rounded-sm transition-colors"
            title="Quit Game"
          >
            <X size={16} />
          </button>
        </div>

        {/* Instructions */}
        <p className="text-sm text-os-text-secondary text-center mb-6">
          Click tiles to toggle them and neighbors. Make all tiles the same to win!
        </p>

        {/* Grids Layout */}
        {isSinglePlayer ? (
          // Single player - just show my grid centered
          <div className="flex justify-center">
            {renderGrid(tilesState.myGrid, true, null, tilesState.myMoves, tilesState.mySolved, false)}
          </div>
        ) : (
          // Multiplayer - my grid in center, opponents on sides
          <div className="flex flex-col items-center">
            <div className="flex gap-4 items-start justify-center">
              {/* Left side - opponents */}
              {hasOpponents && (
                <div className="flex flex-col gap-4 max-w-[200px]">
                  {tilesState.opponentStates.slice(0, Math.ceil(tilesState.opponentStates.length / 2)).map(opp => (
                    <div key={opp.id}>
                      {renderGrid(opp.grid, false, opp.name, opp.moves, opp.solved, true)}
                    </div>
                  ))}
                </div>
              )}

              {/* Center - my grid (normal size) */}
              <div className="shrink-0">
                {renderGrid(tilesState.myGrid, true, null, tilesState.myMoves, tilesState.mySolved, false)}
              </div>

              {/* Right side - remaining opponents */}
              {hasOpponents && tilesState.opponentStates.length > 1 && (
                <div className="flex flex-col gap-4 max-w-[200px]">
                  {tilesState.opponentStates.slice(Math.ceil(tilesState.opponentStates.length / 2)).map(opp => (
                    <div key={opp.id}>
                      {renderGrid(opp.grid, false, opp.name, opp.moves, opp.solved, true)}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Waiting Message - shown when player gave up or solved */}
            {(tilesState.gaveUp || tilesState.mySolved) && (
              <div className="mt-6 text-center">
                <p className="text-sm text-gray-500 italic">
                  Waiting for other players to finish...
                </p>
              </div>
            )}
          </div>
        )}

        {/* Confirmation Modal (replaces native window.confirm for give-up) */}
        <ConfirmationModal {...confirmationProps} />
      </div>
    );
  }

  // Render results
  if (gameState === GAME_STATES.RESULTS) {
    // For Tiles, score = move count (lower is better)
    // Players who gave up are marked as "Unranked" with score = Infinity
    const playersWithScores = players.map(p => {
      const playerResult = tilesState.playerResults?.find(pr => pr.id === p.id);
      const gaveUp = playerResult?.gaveUp || false;
      const playerMoves = gaveUp ? Infinity : (scoreHistory[p.id]?.[0] || 0);

      return {
        ...p,
        score: playerMoves,
        gaveUp
      };
    });

    // Additional data for results screen
    const additionalData = {
      timeElapsed: tilesState.timeElapsed,
    };

    return (
      <GameResults
        gameMode="tiles"
        players={playersWithScores}
        scoreHistory={scoreHistory}
        currentMachineId={currentMachineId}
        onBackToGames={() => {
          setGameState(GAME_STATES.GAME_BROWSER);
          setGameId(null);
          setIsHost(false);
          setIsSinglePlayer(false);
        }}
        additionalData={additionalData}
      />
    );
  }

  return null;
}
