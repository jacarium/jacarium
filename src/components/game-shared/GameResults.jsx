import { Trophy } from 'lucide-react';
import ScoreGraph from './ScoreGraph';

/**
 * GameResults - Shared results/scoreboard screen
 * Displays winner announcement, final standings, and score progression
 *
 * @param {Object} props
 * @param {string} props.gameMode - Game mode ('quiz' | 'grid' | 'tiles')
 * @param {Array} props.players - List of players with scores
 * @param {Object} props.scoreHistory - Score history by player ID
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {Function} props.onBackToGames - Callback to return to games
 * @param {Object} [props.additionalData] - Optional game-specific data (questions, answers, etc.)
 */
export default function GameResults({
  gameMode,
  players,
  scoreHistory,
  currentMachineId,
  onBackToGames,
  additionalData = {}
}) {
  // Sort players by score (for Tiles, lower is better; for others, higher is better)
  const sortedPlayers = [...players].sort((a, b) => {
    if (gameMode === 'tiles') {
      // Lower moves is better
      return (a.score || Infinity) - (b.score || Infinity);
    } else {
      // Higher score is better
      return (b.score || 0) - (a.score || 0);
    }
  });
  const topScore = sortedPlayers[0]?.score || 0;
  const winners = sortedPlayers.filter(p => p.score === topScore);

  // Check if it's a draw (all players have same score)
  const isDraw = sortedPlayers.length > 1 && sortedPlayers.every(p => p.score === topScore);
  const hasMultipleWinners = winners.length > 1 && !isDraw;

  // Generate x-axis labels for quiz mode
  const xAxisLabels = gameMode === 'quiz' && additionalData.questions
    ? additionalData.questions.map((_, idx) => `Q${idx + 1}`)
    : undefined;

  // Get title based on mode
  const getTitle = () => {
    switch (gameMode) {
      case 'quiz': return 'Quiz Complete!';
      case 'grid': return 'Grid Complete!';
      case 'tiles': return 'Game Over!';
      default: return 'Game Over!';
    }
  };

  // Get color based on mode
  const getModeColor = () => {
    switch (gameMode) {
      case 'quiz': return 'text-os-blue';
      case 'grid': return 'text-(--chart-warn)';
      case 'tiles': return 'text-(--brand-accent)';
      default: return 'text-os-blue';
    }
  };

  const getButtonColor = () => {
    switch (gameMode) {
      case 'quiz': return 'bg-os-blue hover:bg-os-blue-hover';
      case 'grid': return 'bg-(--chart-warn) hover:bg-(--chart-warn)';
      case 'tiles': return 'bg-(--brand-accent) hover:bg-(--brand-accent)';
      default: return 'bg-os-blue hover:bg-os-blue-hover';
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto">
      {/* Winner/Draw Announcement */}
      <div className="text-center mb-4">
        <Trophy size={40} className={`mx-auto ${getModeColor()} mb-3`} />
        <h2 className="text-lg font-semibold text-os-text-primary mb-1">
          {getTitle()}
        </h2>
        {isDraw ? (
          <>
            <p className="text-sm text-os-text-secondary">It's a Draw!</p>
            <p className="text-xl font-bold text-os-text-secondary mt-1">
              {topScore} {gameMode === 'tiles' ? 'moves' : 'points'} each
            </p>
          </>
        ) : hasMultipleWinners ? (
          <>
            <p className="text-sm text-os-text-secondary">
              Winners: <span className="font-bold text-(--chart-info)">{winners.map(w => w.name).join(', ')}</span>
            </p>
            <p className="text-xl font-bold text-(--chart-good) mt-1">
              {topScore} {gameMode === 'tiles' ? 'moves' : 'points'}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-os-text-secondary">
              Winner: <span className="font-bold text-(--chart-info)">{winners[0]?.name || 'Unknown'}</span>
            </p>
            <p className="text-xl font-bold text-(--chart-good) mt-1">
              {topScore} {gameMode === 'tiles' ? 'moves' : 'points'}
            </p>
          </>
        )}
      </div>

      {/* Score Graph - hidden for Tiles */}
      {gameMode !== 'tiles' && scoreHistory && Object.keys(scoreHistory).length > 0 && (
        <div className="mb-4">
          <ScoreGraph
            scoreHistory={scoreHistory}
            players={players}
            currentMachineId={currentMachineId}
            gameMode={gameMode}
            xAxisLabels={xAxisLabels}
          />
        </div>
      )}

      {/* Final Standings */}
      <div className="bg-os-card-secondary rounded-sm p-4 mb-4 border border-os-border">
        <h3 className="text-sm font-semibold text-os-text-primary mb-3">Final Standings:</h3>
        <div className="space-y-2">
          {sortedPlayers.map((player, idx) => (
            <div
              key={player.id}
              className={`flex items-center justify-between p-2 rounded ${
 player.id === currentMachineId ?'bg-os-blue' :'bg-os-card/10'
 }`}
            >
              <div className="flex items-center gap-3">
                <div className="w-6 text-center">
                  {idx === 0 ? (
                    <Trophy size={16} className="text-(--chart-warn) inline" />
                  ) : idx === 1 ? (
                    <Trophy size={14} className="text-os-text-muted inline" />
                  ) : idx === 2 ? (
                    <Trophy size={12} className="text-(--chart-warn) inline" />
                  ) : (
                    <span className="text-xs text-os-text-muted">#{idx + 1}</span>
                  )}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-os-text-primary flex items-center gap-2 flex-wrap">
                    <span>{player.name}</span>
                    {player.id === currentMachineId && (
                      <span className="text-xs bg-(--status-info-bg) text-(--status-info-fg) px-1.5 py-0.5 rounded-sm">
                        You
                      </span>
                    )}
                    {player.connected === false && (
                      <span className="text-xs bg-os-text-muted/20 text-os-text-muted px-1.5 py-0.5 rounded-sm">
                        Disconnected
                      </span>
                    )}
                    {player.antiCheat && (
                      <span className="text-xs bg-(--status-danger-bg) text-(--status-danger-fg) px-1.5 py-0.5 rounded-sm border border-(--chart-bad)">
                        Anti-cheat detected irregular user behaviour
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right">
                {player.gaveUp || player.score === Infinity ? (
                  <>
                    <div className="text-lg font-bold text-os-text-secondary">∞</div>
                    <div className="text-xs text-os-text-secondary">Unranked</div>
                  </>
                ) : (
                  <>
                    <div className="text-lg font-bold text-os-text-primary">{player.score || 0}</div>
                    <div className="text-xs text-os-text-muted">{gameMode === 'tiles' ? 'moves' : 'points'}</div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Anti-cheat warnings (if any) */}
      {additionalData.antiCheatWarnings && additionalData.antiCheatWarnings.length > 0 && (
        <div className="bg-(--status-danger-bg) border border-(--status-danger-border) rounded-sm p-3 mb-4">
          <h4 className="text-xs font-semibold text-(--status-danger-fg) mb-2">
            Anti-Cheat Warnings:
          </h4>
          <div className="space-y-1">
            {additionalData.antiCheatWarnings.map((warning, idx) => (
              <p key={idx} className="text-xs text-(--status-danger-fg)">
                {warning}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Questions/Answers Reference (Quiz mode) */}
      {gameMode === 'quiz' && additionalData.questions && additionalData.questions.length > 0 && (
        <div className="bg-os-card-secondary rounded-sm p-4 mb-4 border border-os-border">
          <h3 className="text-sm font-semibold text-os-text-primary mb-3">Questions & Answers:</h3>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {additionalData.questions.map((q, idx) => {
              const questionAnswers = (additionalData.questionAnswers || []).filter(
                qa => qa.questionId === q.id
              );
              const correctAnswers = questionAnswers.filter(qa => qa.correct);

              // Get player names who answered correctly
              const correctPlayerNames = correctAnswers
                .map(qa => {
                  const player = players.find(p => p.id === qa.playerId);
                  return player ? player.name : null;
                })
                .filter(Boolean);

              return (
                <div key={q.id} className="bg-os-card p-3 rounded-sm border border-os-border">
                  <div className="flex items-start gap-2 mb-2">
                    <span className="text-xs font-bold text-os-text-muted">Q{idx + 1}</span>
                    <div className="flex-1">
                      <p className="text-xs font-medium text-os-text-primary mb-1">{q.question}</p>
                      <p className="text-xs text-(--chart-good)">
                        Answer: <span className="font-semibold">{q.answer}</span>
                      </p>
                      {correctPlayerNames.length > 0 ? (
                        <p className="text-xs text-os-text-muted mt-1">
                          Answered correctly by: <span className="font-medium text-os-text-secondary">{correctPlayerNames.join(', ')}</span>
                        </p>
                      ) : (
                        <p className="text-xs text-os-text-muted mt-1">
                          No one answered correctly
                        </p>
                      )}
                      {q.source && (
                        <p className="text-xs text-os-text-muted mt-1">Source: {q.source}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Back to Games Button */}
      <button
        onClick={onBackToGames}
        className={`w-full px-4 py-3 ${getButtonColor()} text-white rounded-sm transition-colors`}
      >
        Back to Games
      </button>
    </div>
  );
}
