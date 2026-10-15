import { Play, Edit2, Check } from 'lucide-react';
import { useState } from 'react';
import PlayerList from './PlayerList';

/**
 * GameLobby - Shared lobby screen for all game modes
 * Displays player list, lobby settings, and start button
 *
 * @param {Object} props
 * @param {string} props.gameMode - Current game mode ('quiz' | 'grid' | 'tiles')
 * @param {string} props.gameId - Game/lobby ID
 * @param {string} props.lobbyName - Name of the lobby
 * @param {Array} props.players - List of players
 * @param {boolean} props.isHost - Whether current user is host
 * @param {string} props.hostId - Host player ID
 * @param {boolean} props.isSinglePlayer - Whether this is single player mode
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {boolean} props.canStart - Whether the game can be started
 * @param {Function} props.onStart - Callback when start button is clicked
 * @param {Function} props.onInviteApp - Callback when invite app button is clicked
 * @param {Function} props.onShareWebLink - Callback when share web link button is clicked
 * @param {Function} props.onBack - Callback to go back
 * @param {Function} props.onUpdateLobbyName - Callback when lobby name is updated
 * @param {Object} [props.metadata] - Optional game-specific metadata to display
 * @param {string} [props.startButtonText] - Custom start button text
 */
export default function GameLobby({
  gameId,
  lobbyName,
  players,
  isHost,
  hostId,
  isSinglePlayer,
  currentMachineId,
  canStart,
  onStart,
  onInviteApp,
  onShareWebLink,
  onBack,
  onUpdateLobbyName,
  metadata,
  startButtonText = 'Start Game'
}) {
  const [editingLobbyName, setEditingLobbyName] = useState(false);
  const [localLobbyName, setLocalLobbyName] = useState(lobbyName);

  const activePlayerCount = players.filter(p => p.status !== 'declined').length;

  const handleSaveLobbyName = () => {
    setEditingLobbyName(false);
    if (onUpdateLobbyName && localLobbyName !== lobbyName) {
      onUpdateLobbyName(localLobbyName);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto">
      {/* Header */}
      <div className="mb-4">
        <button
          onClick={onBack}
          className="text-xs text-os-text-secondary hover:text-os-text-primary mb-2"
        >
          ← Back to Game Browser
        </button>

        {/* Lobby Name */}
        <div className="flex items-center justify-between gap-2">
          {editingLobbyName && isHost ? (
            <>
              <input
                type="text"
                value={localLobbyName}
                onChange={(e) => setLocalLobbyName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveLobbyName();
                  } else if (e.key === 'Escape') {
                    setEditingLobbyName(false);
                    setLocalLobbyName(lobbyName);
                  }
                }}
                className="flex-1 text-lg text-os-text-primary bg-os-input-bg border border-os-blue rounded-sm px-2 py-1 focus:outline-hidden"
                autoFocus
              />
              <button
                onClick={handleSaveLobbyName}
                className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
              >
                <Check size={18} className="text-green-600" />
              </button>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-os-text-primary">
                {lobbyName}
              </h2>
              {isHost && (
                <button
                  onClick={() => setEditingLobbyName(true)}
                  className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
                >
                  <Edit2 size={16} className="text-os-text-secondary" />
                </button>
              )}
            </>
          )}
        </div>

        {/* Game metadata */}
        {metadata && (
          <p className="text-xs text-os-text-secondary mt-1">
            {metadata}
          </p>
        )}
      </div>

      {/* Player List */}
      <div className="mb-4">
        <PlayerList
          players={players}
          currentMachineId={currentMachineId}
          hostId={hostId}
          gameId={gameId}
        />
      </div>

      {/* Host Actions */}
      {isHost && (
        <div className="space-y-2">
          {/* Invite buttons (only for multiplayer) */}
          {!isSinglePlayer && (
            <>
              <button
                onClick={onInviteApp}
                disabled={activePlayerCount >= 30}
                className="w-full px-4 py-2.5 bg-os-card hover:bg-os-card-secondary disabled:bg-os-card-secondary disabled:text-os-text-muted text-os-text-primary border border-os-border rounded-sm text-sm flex items-center justify-center gap-2 transition-colors"
              >
                Invite Player (App)
              </button>
              <button
                onClick={onShareWebLink}
                className="w-full px-4 py-2.5 bg-os-card hover:bg-os-card-secondary text-os-text-primary border border-os-border rounded-sm text-sm flex items-center justify-center gap-2 transition-colors"
              >
                Share Link (Web)
              </button>
            </>
          )}

          {/* Start button */}
          <button
            onClick={onStart}
            disabled={!canStart || activePlayerCount < 1}
            className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-os-card-secondary disabled:text-os-text-muted text-white rounded-sm text-sm flex items-center justify-center gap-2 transition-colors"
          >
            <Play size={16} />
            {startButtonText}
          </button>
        </div>
      )}

      {/* Non-host waiting message */}
      {!isHost && (
        <div className="text-center text-os-text-muted">
          <p className="text-sm">Waiting for host to start the game...</p>
        </div>
      )}
    </div>
  );
}
