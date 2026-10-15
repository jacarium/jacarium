/**
 * ScoreGraph - Score progression visualization
 * Displays a line graph showing how player scores changed over time
 *
 * @param {Object} props
 * @param {Object} props.scoreHistory - Score history by player ID { [playerId]: [scores...] }
 * @param {Array} props.players - List of players
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {string} [props.gameMode] - Game mode ('quiz' | 'grid' | 'tiles')
 * @param {Array} [props.xAxisLabels] - Optional labels for x-axis (e.g., ['Q1', 'Q2', ...])
 */
export default function ScoreGraph({
  scoreHistory,
  players,
  currentMachineId,
  gameMode,
  xAxisLabels
}) {
  const graphWidth = 500;
  const graphHeight = 200;

  // Add more bottom padding for Quiz mode to fit Q1, Q2... labels
  const padding = xAxisLabels && xAxisLabels.length > 0
    ? { top: 15, right: 15, bottom: 30, left: 45 }
    : { top: 15, right: 15, bottom: 15, left: 45 };

  const chartWidth = graphWidth - padding.left - padding.right;
  const chartHeight = graphHeight - padding.top - padding.bottom;

  // Player colors
  const colors = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];

  // Find the maximum history length across all players
  let maxHistoryLength = 1;
  players.forEach(player => {
    const history = scoreHistory[player.id] || [0];
    if (history.length > maxHistoryLength) {
      maxHistoryLength = history.length;
    }
  });

  // Calculate min and max scores across all score histories
  let minScore = 0;
  let maxScore = 100;

  players.forEach(player => {
    const history = scoreHistory[player.id] || [0];
    history.forEach(score => {
      if (score < minScore) minScore = score;
      if (score > maxScore) maxScore = score;
    });
  });

  // For Quiz mode, always start from 0 (scores never go negative)
  // For Grid mode, allow negative scores (wrong answers deduct points)
  const yMin = gameMode === 'quiz' || gameMode === 'tiles'
    ? 0
    : (minScore < 0 ? Math.floor(minScore / 50) * 50 : 0);
  const yMax = Math.ceil(maxScore / 50) * 50;
  const yRange = yMax - yMin;
  const yScale = yRange > 0 ? chartHeight / yRange : chartHeight / 100;

  // Spread points evenly across the full width based on max history length
  // Divide by (maxHistoryLength - 1) so points span from 0 to chartWidth
  const xStep = chartWidth / (maxHistoryLength > 1 ? maxHistoryLength - 1 : 1);

  // Generate Y-axis labels (5 evenly spaced labels)
  const yLabels = [];
  const stepSize = yRange / 4;
  for (let i = 0; i <= 4; i++) {
    yLabels.push(Math.round(yMin + i * stepSize));
  }

  // Check if dark mode
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <div className="bg-os-card-secondary rounded-sm p-3 border border-os-border">
      <h3 className="text-xs font-semibold text-os-text-primary mb-2">Score Progression:</h3>
      <svg width={graphWidth} height={graphHeight} className="mx-auto">
        {/* Grid lines */}
        <g>
          {yLabels.map(val => {
            const y = padding.top + chartHeight - ((val - yMin) * yScale);
            return (
              <g key={val}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={padding.left + chartWidth}
                  y2={y}
                  stroke={isDark ? '#4a4a4a' : '#d1d5db'}
                  strokeWidth="1"
                />
                <text
                  x={padding.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="10"
                  fill={isDark ? '#b0b0b0' : '#6B7280'}
                >
                  {val}
                </text>
              </g>
            );
          })}
        </g>

        {/* X-axis labels (if provided) */}
        {xAxisLabels && xAxisLabels.length > 0 && (
          <g>
            {xAxisLabels.map((label, idx) => {
              const x = padding.left + (idx + 1) * xStep;
              return (
                <text
                  key={idx}
                  x={x}
                  y={padding.top + chartHeight + 15}
                  textAnchor="middle"
                  fontSize="10"
                  fill={isDark ? '#b0b0b0' : '#6B7280'}
                >
                  {label}
                </text>
              );
            })}
          </g>
        )}

        {/* Player score lines */}
        {players.map((player, playerIdx) => {
          const history = scoreHistory[player.id] || [0];
          const color = colors[playerIdx % colors.length];

          // Build path
          const pathData = history.map((score, idx) => {
            const x = padding.left + idx * xStep;
            const y = padding.top + chartHeight - ((score - yMin) * yScale);
            return idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
          }).join(' ');

          return (
            <g key={player.id}>
              <path
                d={pathData}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Points */}
              {history.map((score, idx) => {
                const x = padding.left + idx * xStep;
                const y = padding.top + chartHeight - ((score - yMin) * yScale);
                return (
                  <circle
                    key={idx}
                    cx={x}
                    cy={y}
                    r="3"
                    fill={color}
                    stroke="white"
                    strokeWidth="1.5"
                  />
                );
              })}
            </g>
          );
        })}

        {/* Axes */}
        {(() => {
          const axisColor = isDark ? '#808080' : '#9CA3AF';
          return (
            <>
              <line
                x1={padding.left}
                y1={padding.top}
                x2={padding.left}
                y2={padding.top + chartHeight}
                stroke={axisColor}
                strokeWidth="1.5"
              />
              <line
                x1={padding.left}
                y1={padding.top + chartHeight}
                x2={padding.left + chartWidth}
                y2={padding.top + chartHeight}
                stroke={axisColor}
                strokeWidth="1.5"
              />
            </>
          );
        })()}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 justify-center mt-3">
        {players.map((player, idx) => (
          <div key={player.id} className="flex items-center gap-1.5">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: colors[idx % colors.length] }}
            ></div>
            <span className="text-xs text-os-text-secondary">
              {player.name}
              {player.id === currentMachineId && ' (You)'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
