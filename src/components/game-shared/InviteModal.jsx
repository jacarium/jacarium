import { useState, useEffect } from 'react';
import { User } from 'lucide-react';
import { getConnectedUsers, sendQuizChallenge } from '../../utils/cloudWebSocket';

/**
 * InviteModal - Modal for inviting connected users to a game
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether modal is open
 * @param {Function} props.onClose - Callback to close modal
 * @param {string} props.gameId - Game ID to invite to
 * @param {string} props.gameMode - Game mode ('quiz' | 'grid' | 'tiles')
 * @param {Array} props.currentPlayers - List of players already in the game
 */
export default function InviteModal({ isOpen, onClose, gameId, currentPlayers }) {
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [invitedUsers, setInvitedUsers] = useState(new Set());

  useEffect(() => {
    if (isOpen) {
      // Get current connected users
      const users = getConnectedUsers();
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnectedUsers(users);
      setInvitedUsers(new Set());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const currentPlayerIds = new Set(currentPlayers.map(p => p.id));

  // Handle both string arrays and object arrays
  const availableUsers = connectedUsers
    .map(user => {
      // If user is a string (just machine ID), convert to object
      if (typeof user === 'string') {
        return { machineId: user, name: user.split('@')[0] };
      }
      // If user is already an object, use it as-is
      return user;
    })
    .filter(user => {
      const userId = user.machineId || user.id || user.userId;
      return userId && !currentPlayerIds.has(userId);
    });

  const handleInvite = async (user) => {
    try {
      const userId = user.machineId || user.id || user.userId;
      if (!userId) {
        console.error('[InviteModal] User has no valid ID:', user);
        return;
      }

      // Send quiz challenge (works for all game modes - quiz, grid, tiles)
      await sendQuizChallenge(userId, gameId);
      setInvitedUsers(prev => new Set([...prev, userId]));
      console.log(`[InviteModal] Challenge sent to ${userId} for game ${gameId}`);
    } catch (error) {
      console.error('[InviteModal] Failed to send challenge:', error);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={onClose}
      />
      <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-os-card border border-os-border rounded-sm shadow-2xl p-4 z-50 min-w-[350px]">
        <h3 className="text-sm font-semibold text-os-text-primary mb-3">Invite Players</h3>
        <div className="space-y-1.5 max-h-[300px] overflow-y-auto mb-3">
          {availableUsers.length === 0 ? (
            <p className="text-xs text-os-text-muted text-center py-3">No other users connected</p>
          ) : (
            availableUsers.map((user) => {
              const userId = user.machineId || user.id || user.userId;
              const displayName = user.name || (userId && userId.includes('@') ? userId.split('@')[0] : userId) || 'Unknown';
              const isInvited = invitedUsers.has(userId);

              return (
                <button
                  key={userId}
                  onClick={() => !isInvited && handleInvite(user)}
                  disabled={isInvited}
                  className={`w-full px-3 py-2 bg-os-card hover:bg-os-card-secondary border border-os-border text-left transition-colors flex items-center gap-2 ${
 isInvited ?'opacity-50 cursor-not-allowed':''
 }`}
                >
                  <span className="text-sm font-medium text-os-text-primary">{displayName}</span>
                  {isInvited && <span className="ml-auto text-xs text-green-600 dark:text-green-400">✓ Invited</span>}
                </button>
              );
            })
          )}
        </div>
        <button
          onClick={onClose}
          className="w-full px-3 py-2 bg-os-card-secondary hover:bg-os-card text-os-text-primary rounded-sm text-sm transition-colors"
        >
          Close
        </button>
      </div>
    </>
  );
}
