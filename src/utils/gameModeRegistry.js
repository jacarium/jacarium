import { Trophy, Grid3x3, Layers } from 'lucide-react';
import QuizGameMode from '../components/game-modes/QuizGameMode';
import GridGameMode from '../components/game-modes/GridGameMode';
import TilesGameMode from '../components/game-modes/TilesGameMode';

/**
 * Game Mode Registry
 * Central registry for all available game modes in the Floating Quiz window
 *
 * Each game mode is a self-contained component with:
 * - Own state management
 * - Own event handlers
 * - Own render logic
 * - Consistent props interface
 */

export const GAME_MODES = [
  {
    id: 'quiz',
    name: 'Quiz',
    description: '10 random questions with hints and timer',
    icon: Trophy,
    color: 'text-os-blue',
    component: QuizGameMode,
    features: ['Single Player', 'Multiplayer', 'AI Generated', 'Custom Quizzes'],
  },
  {
    id: 'grid',
    name: 'Grid',
    description: '30 questions in a 6×5 Jeopardy-style grid',
    icon: Grid3x3,
    color: 'text-yellow-500',
    component: GridGameMode,
    features: ['Multiplayer', 'Category Selection', 'Buzz-In', 'Timer'],
  },
  {
    id: 'tiles',
    name: 'Tiles',
    description: 'Lights Out puzzle - make all tiles the same',
    icon: Layers,
    color: 'text-purple-500',
    component: TilesGameMode,
    features: ['Single Player', 'Multiplayer', 'Offline Support', 'Multiple Difficulties'],
  },
];

/**
 * Get game mode by ID
 * @param {string} modeId - The game mode ID
 * @returns {Object|null} Game mode object or null if not found
 */
export function getGameMode(modeId) {
  return GAME_MODES.find(mode => mode.id === modeId) || null;
}

/**
 * Get game mode component by ID
 * @param {string} modeId - The game mode ID
 * @returns {React.Component|null} Game mode component or null if not found
 */
export function getGameModeComponent(modeId) {
  const mode = getGameMode(modeId);
  return mode ? mode.component : null;
}

/**
 * Get all game mode IDs
 * @returns {string[]} Array of game mode IDs
 */
export function getAllGameModeIds() {
  return GAME_MODES.map(mode => mode.id);
}

/**
 * Check if a game mode exists
 * @param {string} modeId - The game mode ID
 * @returns {boolean} True if mode exists
 */
export function gameModeExists(modeId) {
  return GAME_MODES.some(mode => mode.id === modeId);
}
