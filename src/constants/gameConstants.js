/**
 * Shared game constants for Quiz and Grid modes
 */

export const GAME_STATES = {
  CLOSED: 'closed',
  MODE_SELECT: 'mode-select',
  GAME_BROWSER: 'game-browser', // Intermediate screen to create/join games
  LOBBY: 'lobby',
  PLAYING: 'playing',
  RESULTS: 'results',
  // Grid-specific states
  GRID_BOARD: 'grid-board',
  GRID_QUESTION: 'grid-question',
  GRID_BUZZER: 'grid-buzzer',
  GRID_ANSWER: 'grid-answer',
  GRID_RESULTS: 'grid-results'
};

export const POINTS_PER_QUESTION = 100;
export const POINTS_DEDUCTION_PER_HINT = 25;
export const QUESTION_TIME_SECONDS = 30;
export const MAX_HINTS_PER_QUESTION = 3;

// Grid constants
export const GRID_POINT_VALUES = [100, 200, 300, 400, 500];
export const GRID_ANSWER_TIME = 10; // seconds to answer after buzzing
export const GRID_BUZZ_WINDOW = 10; // seconds for others to buzz after incorrect answer
export const GRID_GAME_TIME = 300; // 5 minutes game session time
export const TYPING_SPEED_MS = 50; // 50ms per character for typewriter effect
export const TYPING_DELAY_MS = 1000; // 1 second delay before starting typewriter
