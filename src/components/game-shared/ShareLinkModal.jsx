import { useState } from 'react';
import { Copy, Check, X } from 'lucide-react';

/**
 * ShareLinkModal - Modal for sharing game link
 *
 * @param {Object} props
 * @param {boolean} props.isOpen - Whether modal is open
 * @param {Function} props.onClose - Callback to close modal
 * @param {string} props.gameUrl - The game URL to share
 * @param {string} props.gameMode - Game mode ('quiz' | 'grid' | 'tiles')
 */
export default function ShareLinkModal({ isOpen, onClose, gameUrl, gameMode }) {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(gameUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('[ShareLinkModal] Failed to copy:', error);
    }
  };

  const gameModeTitle = gameMode === 'quiz' ? 'Quiz' : gameMode === 'grid' ? 'Grid' : 'Tiles';

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={onClose}
      />
      <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-os-card border border-os-border rounded-sm shadow-2xl p-4 z-50 min-w-[400px] max-w-[500px]">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-os-text-primary flex items-center gap-2">
            Share {gameModeTitle} Link
          </h3>
          <button
            onClick={onClose}
            className="text-os-text-secondary hover:text-os-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <p className="text-xs text-os-text-secondary mb-3">
          Share this link with others to invite them to join via web browser:
        </p>

        <div className="bg-os-card-secondary border border-os-border rounded-sm p-3 mb-3">
          <p className="text-xs text-os-text-primary font-mono break-all select-all">
            {gameUrl}
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-sm text-sm transition-colors flex items-center justify-center gap-2"
          >
            {copied ? (
              <>
                <Check size={14} />
                Copied!
              </>
            ) : (
              <>
                Copy Link
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className="px-3 py-2 bg-os-card hover:bg-os-card-secondary text-os-text-primary border border-os-border rounded-sm text-sm transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </>
  );
}
