import { Users, Server } from 'lucide-react';

/**
 * GameBrowser - Browse and join available games from server
 * Shows reconnectable games, open lobbies, and running games
 *
 * @param {Object} props
 * @param {string} props.gameMode - Current game mode ('quiz' | 'grid' | 'tiles')
 * @param {string} props.modeTitle - Display title for the mode
 * @param {string} props.modeDescription - Description of the mode
 * @param {Array} props.availableGames - List of all available games
 * @param {boolean} props.isCentralServerConnected - Connection status
 * @param {boolean} props.loadingGames - Whether games are being loaded
 * @param {Function} props.onBack - Callback to go back
 * @param {Function} props.onCreateSinglePlayer - Callback to create single player game
 * @param {Function} props.onCreateMultiplayer - Callback to create multiplayer game
 * @param {Function} props.onJoinGame - Callback when joining a game
 */
export default function GameBrowser({
  gameMode,
  modeTitle,
  modeDescription,
  availableGames,
  isCentralServerConnected,
  loadingGames,
  onBack,
  onCreateSinglePlayer,
  onCreateMultiplayer,
  onJoinGame
}) {
  // Filter and categorize games
  const gamesForMode = availableGames.filter(g => g.mode === gameMode);
  const myDisconnectedGames = gamesForMode.filter(g => g.canReconnect);
  const openLobbies = gamesForMode.filter(g => g.status === 'lobby' && !g.canReconnect);
  const runningGames = gamesForMode.filter(g => g.status === 'playing' && !g.canReconnect);

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto">
      {/* Header */}
      <div className="mb-4">
        <button
          onClick={onBack}
          className="text-xs text-os-text-secondary hover:text-os-text-primary mb-2"
        >
          ← Back to Mode Selection
        </button>
        <h2 className="text-lg font-semibold text-os-text-primary">{modeTitle} Games</h2>
        <p className="text-xs text-os-text-secondary">{modeDescription}</p>
      </div>

      {/* Central Server Connection Warning */}
      {!isCentralServerConnected && (
        <div className="bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-2">
            <Server size={16} className="text-yellow-600 dark:text-yellow-400 mt-0.5" />
            <div>
              <h4 className="text-sm font-semibold text-yellow-800 dark:text-yellow-200 mb-1">
                Central Server Offline
              </h4>
              <p className="text-xs text-yellow-700 dark:text-yellow-300">
                Multiplayer and game browsing require connection to the central server. You can still play in single player mode.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Create New Game */}
      <div className="bg-os-card-secondary rounded-lg p-4 mb-4 border border-os-border">
        <h3 className="text-sm font-semibold text-os-text-primary mb-3">Create New Game</h3>
        <div className="flex gap-2">
          <button
            onClick={onCreateSinglePlayer}
            className="flex-1 px-4 py-2 bg-os-blue hover:bg-blue-600 text-white rounded-sm text-sm transition-colors flex items-center justify-center gap-2"
          >
            Single Player
          </button>
          <button
            onClick={onCreateMultiplayer}
            disabled={!isCentralServerConnected}
            className={`flex-1 px-4 py-2 text-sm transition-colors flex items-center justify-center gap-2 ${
 isCentralServerConnected
 ?'bg-green-600 hover:bg-green-700 text-white'
 :'bg-os-text-muted text-white cursor-not-allowed opacity-50'
 }`}
            title={!isCentralServerConnected ? 'Multiplayer requires connection to central server' : ''}
          >
            Multiplayer
          </button>
        </div>
        {!isCentralServerConnected && (
          <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-2 flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Central server offline - Multiplayer unavailable
          </p>
        )}
      </div>

      {/* Your Games (Reconnectable) */}
      {myDisconnectedGames.length > 0 && (
        <div className="bg-os-card-secondary rounded-lg p-4 mb-4 border border-os-border">
          <h3 className="text-sm font-semibold text-os-text-primary mb-3">Your Games</h3>
          <div className="space-y-2">
            {myDisconnectedGames.map((game) => (
              <div key={game.gameId} className="bg-os-card p-3 rounded-sm border border-os-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-os-text-primary">
                      {game.lobbyName || `${modeTitle} Game`}
                    </div>
                    <span className="text-xs bg-yellow-500/20 text-yellow-600 px-2 py-0.5 rounded-sm">
                      {game.status === 'lobby' ? 'In Lobby' : 'Playing'}
                    </span>
                  </div>
                  <button
                    onClick={() => onJoinGame(game)}
                    className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded-sm text-xs transition-colors"
                  >
                    Reconnect
                  </button>
                </div>
                <div className="text-xs text-os-text-secondary">
                  {game.connectedPlayerCount} / {game.playerCount} players connected
                </div>
                <div className="text-xs text-os-text-muted">
                  ID: {game.gameId.split('-').pop()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open Lobbies */}
      {openLobbies.length > 0 && (
        <div className="bg-os-card-secondary rounded-lg p-4 mb-4 border border-os-border">
          <h3 className="text-sm font-semibold text-os-text-primary mb-3">Open Lobbies</h3>
          <div className="space-y-2">
            {openLobbies.map((game) => (
              <div key={game.gameId} className="bg-os-card p-3 rounded-sm border border-os-border">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-os-text-primary">
                      {game.lobbyName || `${modeTitle} Game`}
                    </div>
                    <span className="text-xs bg-blue-500/20 text-blue-600 px-2 py-0.5 rounded-sm">
                      Open
                    </span>
                  </div>
                  <button
                    onClick={() => onJoinGame(game)}
                    className="px-3 py-1 bg-os-blue hover:bg-blue-600 text-white rounded-sm text-xs transition-colors"
                  >
                    Join
                  </button>
                </div>
                <div className="text-xs text-os-text-secondary">
                  {game.playerCount} player{game.playerCount !== 1 ? 's' : ''} waiting
                </div>
                <div className="text-xs text-os-text-muted">
                  ID: {game.gameId.split('-').pop()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Running Games */}
      {runningGames.length > 0 && (
        <div className="bg-os-card-secondary rounded-lg p-4 mb-4 border border-os-border">
          <h3 className="text-sm font-semibold text-os-text-primary mb-3">Running Games</h3>
          <div className="space-y-2">
            {runningGames.map((game) => (
              <div key={game.gameId} className="bg-os-card p-3 rounded-sm border border-os-border opacity-60">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-os-text-primary">
                      {game.lobbyName || `${modeTitle} Game`}
                    </div>
                    <span className="text-xs bg-os-text-muted/20 text-os-text-muted px-2 py-0.5 rounded-sm">
                      In Progress
                    </span>
                  </div>
                </div>
                <div className="text-xs text-os-text-secondary">
                  {game.playerCount} player{game.playerCount !== 1 ? 's' : ''}
                </div>
                <div className="text-xs text-os-text-muted">
                  ID: {game.gameId.split('-').pop()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!loadingGames && myDisconnectedGames.length === 0 && openLobbies.length === 0 && runningGames.length === 0 && (
        <div className="text-center py-8">
          <Users size={32} className="mx-auto text-os-text-muted mb-2" />
          <p className="text-sm text-os-text-secondary">No active games</p>
          <p className="text-xs text-os-text-muted">Create a new game to get started!</p>
        </div>
      )}
    </div>
  );
}
