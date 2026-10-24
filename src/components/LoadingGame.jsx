import React, { useState } from 'react';

const GRID_SIZE = 5;

// Toggle a cell and its adjacent cells (mutates the passed grid copy)
function toggleCell(gridState, row, col) {
  const directions = [
    [0, 0],   // self
    [-1, 0],  // up
    [1, 0],   // down
    [0, -1],  // left
    [0, 1],   // right
  ];

  directions.forEach(([dr, dc]) => {
    const newRow = row + dr;
    const newCol = col + dc;

    if (newRow >= 0 && newRow < GRID_SIZE && newCol >= 0 && newCol < GRID_SIZE) {
      gridState[newRow][newCol] = !gridState[newRow][newCol];
    }
  });
}

// Build a random solvable pattern by starting with all lights off and
// simulating a handful of clicks. Lives outside the component so the
// randomness clearly runs from effects/event handlers, never render.
function generateSolvableGrid() {
  const newGrid = Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill(false));

  const randomClicks = Math.floor(Math.random() * 10) + 5; // 5-15 random clicks
  for (let i = 0; i < randomClicks; i++) {
    const row = Math.floor(Math.random() * GRID_SIZE);
    const col = Math.floor(Math.random() * GRID_SIZE);
    toggleCell(newGrid, row, col);
  }

  return newGrid;
}

const LoadingGame = ({ message = "Loading..." }) => {
  // Lazy initializer builds the starting puzzle once, before first paint
  const [grid, setGrid] = useState(generateSolvableGrid);
  const [moves, setMoves] = useState(0);
  const [isWon, setIsWon] = useState(false);

  // (Re)initialize grid with a random solvable pattern
  const initializeGrid = () => {
    setGrid(generateSolvableGrid());
    setMoves(0);
    setIsWon(false);
  };

  // Handle cell click
  const handleCellClick = (row, col) => {
    if (isWon) return;

    const newGrid = grid.map(row => [...row]); // Deep copy
    toggleCell(newGrid, row, col);
    setGrid(newGrid);
    setMoves(moves + 1);

    // Check if won (all tiles same state - either all on OR all off)
    const allOff = newGrid.every(row => row.every(cell => !cell));
    const allOn = newGrid.every(row => row.every(cell => cell));
    if (allOff || allOn) {
      setIsWon(true);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center w-full h-full">
      {/* Header */}
      <div className="mb-6 text-center">
        <p className="text-sm text-os-text-secondary mb-4">{message}</p>
        <div className="flex justify-center items-center gap-6 text-os-text-primary">
          <div>
            <span className="text-sm text-os-text-secondary">Moves: </span>
            <span className="font-bold">{moves}</span>
          </div>
          {isWon && (
            <div className="text-green-600 dark:text-green-400 font-bold">
              Completed in {moves} moves
            </div>
          )}
        </div>
      </div>

      {/* Game Grid */}
      <div className="flex justify-center mb-6">
        <div
          className="inline-grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${GRID_SIZE}, minmax(0, 1fr))`,
          }}
        >
          {grid.map((row, rowIndex) => (
            row.map((cell, colIndex) => (
              <button
                key={`${rowIndex}-${colIndex}`}
                onClick={() => handleCellClick(rowIndex, colIndex)}
                className={`
                  w-16 h-16 rounded-lg border-2 transition-all duration-200
                  ${cell
                    ? 'bg-yellow-400 border-yellow-500 shadow-lg shadow-yellow-500/50'
                    : 'bg-gray-700 border-gray-600 dark:bg-gray-800 dark:border-gray-700'
                  }
                  ${!isWon ? 'hover:scale-105 active:scale-95 cursor-pointer' : 'cursor-default'}
                `}
                disabled={isWon}
                aria-label={`Cell ${rowIndex},${colIndex} - ${cell ? 'on' : 'off'}`}
              />
            ))
          ))}
        </div>
      </div>

      {/* Instructions and Reset */}
      <div className="text-center">
        <p className="text-sm text-os-text-secondary mb-4">
          Click a tile to toggle it and its neighbors. Make all tiles the same to win!
        </p>
        <button
          onClick={initializeGrid}
          className="btn btn-primary px-4 py-2"
        >
          New Game
        </button>
      </div>
    </div>
  );
};

export default LoadingGame;
