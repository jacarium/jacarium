import { Users, Grid3x3, Layers } from 'lucide-react';

/**
 * ModeSelector - Initial game mode selection screen
 * Displays Quiz, Grid, and Tiles game mode cards
 *
 * @param {Object} props
 * @param {Function} props.onSelectMode - Callback when a mode is selected (modeId: 'quiz' | 'grid' | 'tiles')
 */
export default function ModeSelector({ onSelectMode }) {
  const modes = [
    {
      id: 'quiz',
      name: 'Quiz',
      description: 'Classic quiz mode with 10 random questions',
      icon: Users,
      color: 'text-os-blue',
      hoverColor: 'hover:border-os-blue',
    },
    {
      id: 'grid',
      name: 'Grid',
      description: 'Grid quiz mode with 30 random questions',
      icon: Grid3x3,
      color: 'text-yellow-500',
      hoverColor: 'hover:border-yellow-500',
    },
    {
      id: 'tiles',
      name: 'Tiles',
      description: 'Puzzle game - make all tiles the same',
      icon: Layers,
      color: 'text-purple-500',
      hoverColor: 'hover:border-purple-500',
    },
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-os-text-primary mb-2">Choose Game Mode</h2>
        <p className="text-sm text-os-text-secondary">Select how you'd like to play</p>
      </div>

      <div className="flex gap-4 w-full max-w-md">
        {modes.map((mode) => {
          const Icon = mode.icon;
          return (
            <button
              key={mode.id}
              onClick={() => onSelectMode(mode.id)}
              className={`flex-1 flex flex-col items-center gap-3 p-6 bg-os-card border-2 border-os-border ${mode.hoverColor} hover:bg-os-card-secondary transition-all group cursor-pointer`}
            >
              <Icon size={32} className={`${mode.color} group-hover:scale-110 transition-transform`} />
              <div>
                <div className="flex items-center justify-center gap-2 mb-1">
                  <h3 className="text-lg font-semibold text-os-text-primary">{mode.name}</h3>
                </div>
                <p className="text-xs text-os-text-secondary">{mode.description}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
