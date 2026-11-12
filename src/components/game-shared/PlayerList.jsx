import { Globe, Monitor } from 'lucide-react';

/**
 * PlayerList - Reusable player list component
 * Displays players with their status, connection state, and badges
 *
 * @param {Object} props
 * @param {Array} props.players - Array of player objects
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {string} props.hostId - Host player's ID
 * @param {boolean} [props.showScores=false] - Whether to show player scores
 * @param {string} [props.gameId] - Optional game ID to display
 */
export default function PlayerList({
  players,
  currentMachineId,
  hostId,
  showScores = false,
  gameId
}) {
  const activePlayerCount = players.filter(p => p.status !== 'declined').length;

  return (
    <div className="bg-os-card-secondary rounded-lg p-4 border border-os-border">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-os-text-primary flex items-center gap-2">
          Players ({activePlayerCount}/{players.length})
        </h3>
        {gameId && (
          <span className="text-xs text-os-text-muted">Game ID: {gameId}</span>
        )}
      </div>

      <div className="space-y-1.5">
        {players.map((player) => {
          // Infer clientType from player ID if missing (web players have IDs starting with "web-")
          const clientType = player.clientType || (player.id.startsWith('web-') ? 'web' : 'app');

          return (
            <div
              key={player.id}
              className={`flex items-center justify-between bg-os-card p-2 rounded border border-os-border ${
 player.connected === false ?'opacity-60':''
 }`}
            >
              <div className="flex items-center gap-2">
                {/* Connection indicator */}
                {player.connected === false ? (
                  <Globe size={16} className="text-os-text-secondary" title="Disconnected" />
                ) : clientType === 'web' ? (
                  <Globe size={16} className="text-(--chart-good)" title="Web Browser" />
                ) : (
                  <Monitor size={16} className="text-os-blue" title="Desktop App" />
                )}

              {/* Player name */}
              <span className="text-sm font-medium text-os-text-primary">{player.name}</span>

              {/* Score (optional) */}
              {showScores && player.score !== undefined && (
                <span className="text-xs text-os-text-secondary ml-2">
                  ({player.score} pts)
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {/* Status badges */}
              {player.connected === false && (
                <span className="text-xs bg-os-text-muted/20 text-os-text-muted px-1.5 py-0.5 rounded-sm">
                  Disconnected
                </span>
              )}
              {player.status === 'pending' && player.connected !== false && (
                <span className="text-xs bg-(--status-warning-bg) text-(--status-warning-fg) px-1.5 py-0.5 rounded-sm">
                  Pending
                </span>
              )}
              {player.status === 'ready' && player.id !== currentMachineId && player.connected !== false && (
                <span className="text-xs bg-(--status-success-bg) text-(--status-success-fg) px-1.5 py-0.5 rounded-sm">
                  Ready
                </span>
              )}
              {player.status === 'declined' && player.connected !== false && (
                <span className="text-xs bg-(--status-danger-bg) text-(--status-danger-fg) px-1.5 py-0.5 rounded-sm">
                  Declined
                </span>
              )}
              {player.id === currentMachineId && player.connected !== false && (
                <span className="text-xs bg-os-blue/20 text-(--chart-info) px-1.5 py-0.5 rounded-sm">
                  You
                </span>
              )}
              {(hostId ? player.id === hostId : players[0]?.id === player.id) && (
                <span className="text-xs bg-(--brand-accent) text-white px-1.5 py-0.5 rounded-sm">
                  Host
                </span>
              )}
            </div>
          </div>
        );
        })}
      </div>
    </div>
  );
}
