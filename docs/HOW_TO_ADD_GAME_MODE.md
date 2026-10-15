# How to Add a New Game Mode

Simple step-by-step guide to add a new game mode to the Floating Quiz window in Jacarium.

## Overview

The Floating Quiz window uses a modular architecture with three game modes:
- **Quiz** - 10 question quiz with hints and timer
- **Grid** - 6×5 Jeopardy-style game board
- **Tiles** - Lights Out puzzle game

Each mode is a self-contained component that follows consistent patterns.

## Steps

### 1. Create Game Mode Component

Create a new file: `src/components/game-modes/YourGameMode.jsx`

```jsx
import { useState, useEffect } from 'react';
import { User, Users, Play, YourIcon } from 'lucide-react';
import { GAME_STATES } from '../../constants/gameConstants';
import { useYourGameEventListeners } from '../../hooks/useYourGameEventListeners';
import {
  sendYourGameJoin,
  sendYourGameStart,
  sendLobbyNameUpdate,
  onLobbyNameUpdate
} from '../../utils/cloudWebSocket';
import GameBrowser from '../game-shared/GameBrowser';
import GameLobby from '../game-shared/GameLobby';
import GameResults from '../game-shared/GameResults';

/**
 * YourGameMode - Complete game mode implementation
 * Brief description of your game
 *
 * @param {Object} props
 * @param {Function} props.onBack - Callback to return to mode selection
 * @param {string} props.currentMachineId - Current user's machine ID
 * @param {boolean} props.isCentralServerConnected - Connection status
 */
export default function YourGameMode({ onBack, currentMachineId, isCentralServerConnected }) {
  // Game session state (REQUIRED)
  const [gameState, setGameState] = useState(GAME_STATES.GAME_BROWSER);
  const [gameId, setGameId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState(null);
  const [isSinglePlayer, setIsSinglePlayer] = useState(false);
  const [players, setPlayers] = useState([]);
  const [lobbyName, setLobbyName] = useState('');
  const [scoreHistory, setScoreHistory] = useState({});

  // Your game-specific state
  const [yourGameState, setYourGameState] = useState({
    // Add your game state here
  });

  // Event listeners for multiplayer
  useYourGameEventListeners({
    gameId,
    isHost,
    currentMachineId,
    players,
    setPlayers,
    setGameState,
    setYourGameState,
    setScoreHistory,
  });

  // Lobby name listener
  useEffect(() => {
    if (!gameId) return;
    const unsub = onLobbyNameUpdate((data) => {
      if (data.gameId === gameId) setLobbyName(data.lobbyName);
    });
    return unsub;
  }, [gameId]);

  // Handlers
  async function createLobby() {
    const newGameId = `yourgame-${Date.now()}`;
    const playerName = currentMachineId.split('@')[0];

    setGameId(newGameId);
    setIsHost(true);
    setHostId(currentMachineId);
    setGameState(GAME_STATES.LOBBY);

    const defaultLobbyName = `${playerName}'s Game`;
    setLobbyName(defaultLobbyName);
    setPlayers([{
      id: currentMachineId,
      name: playerName,
      score: 0,
      ready: true,
      status: 'ready',
      clientType: 'app'
    }]);

    if (!isSinglePlayer) {
      try {
        await sendYourGameJoin(newGameId, currentMachineId, playerName);
        await sendLobbyNameUpdate(newGameId, defaultLobbyName);
      } catch (error) {
        console.error('[YourGame] Failed to create lobby:', error);
      }
    }
  }

  async function startGame() {
    if (!isHost || !gameId) return;

    setGameState(GAME_STATES.PLAYING);

    if (!isSinglePlayer) {
      try {
        await sendYourGameStart(gameId);
      } catch (error) {
        console.error('[YourGame] Failed to start:', error);
      }
    }
  }

  // Main render logic
  if (gameState === GAME_STATES.GAME_BROWSER) {
    return (
      <GameBrowser
        gameMode="yourgame"
        modeTitle="Your Game"
        modeDescription="Brief description"
        availableGames={[]}
        isCentralServerConnected={isCentralServerConnected}
        loadingGames={false}
        onBack={onBack}
        onCreateSinglePlayer={() => {
          setIsSinglePlayer(true);
          setGameState(GAME_STATES.CLOSED);
        }}
        onCreateMultiplayer={() => {
          setIsSinglePlayer(false);
          setGameState(GAME_STATES.CLOSED);
        }}
        onJoinGame={() => {}}
      />
    );
  }

  if (gameState === GAME_STATES.LOBBY) {
    return (
      <GameLobby
        gameMode="yourgame"
        gameId={gameId}
        lobbyName={lobbyName}
        players={players}
        isHost={isHost}
        hostId={hostId}
        isSinglePlayer={isSinglePlayer}
        currentMachineId={currentMachineId}
        canStart={true}
        onStart={startGame}
        onInviteApp={() => {}}
        onShareWebLink={() => {}}
        onBack={() => setGameState(GAME_STATES.GAME_BROWSER)}
        onUpdateLobbyName={(name) => {
          setLobbyName(name);
          if (gameId) sendLobbyNameUpdate(gameId, name);
        }}
        metadata="Your Game - metadata"
        startButtonText="Start Game"
      />
    );
  }

  if (gameState === GAME_STATES.PLAYING) {
    return (
      <div className="flex-1 flex flex-col p-4">
        {/* Your game UI here */}
        <p className="text-sm text-os-text-primary">Game is playing...</p>
      </div>
    );
  }

  if (gameState === GAME_STATES.RESULTS) {
    return (
      <GameResults
        gameMode="yourgame"
        players={players}
        scoreHistory={scoreHistory}
        currentMachineId={currentMachineId}
        onBackToGames={() => {
          setGameState(GAME_STATES.GAME_BROWSER);
          setGameId(null);
        }}
      />
    );
  }

  return null;
}
```

### 2. Create Event Listeners Hook (Optional for Multiplayer)

If your game needs multiplayer support, create: `src/hooks/useYourGameEventListeners.js`

```javascript
import { useEffect } from 'react';
import {
  onYourGameStateUpdate,
  onYourGamePlayerJoined,
  onYourGamePlayerLeft,
  onYourGameStarted,
  // ... other events
} from '../utils/cloudWebSocket';

export function useYourGameEventListeners({
  gameId,
  isHost,
  currentMachineId,
  players,
  setPlayers,
  setGameState,
  setYourGameState,
  setScoreHistory,
}) {
  useEffect(() => {
    if (!gameId) return;

    const unsubscribers = [];

    // Player joined
    unsubscribers.push(
      onYourGamePlayerJoined((data) => {
        if (data.gameId !== gameId) return;
        // Handle player joined
      })
    );

    // Game started
    unsubscribers.push(
      onYourGameStarted((data) => {
        if (data.gameId !== gameId) return;
        setGameState(GAME_STATES.PLAYING);
      })
    );

    // State update
    unsubscribers.push(
      onYourGameStateUpdate((data) => {
        if (data.gameId !== gameId) return;
        setYourGameState(data.state);
      })
    );

    return () => unsubscribers.forEach(unsub => unsub());
  }, [gameId, isHost, currentMachineId]);
}
```

### 3. Add WebSocket Events (Optional for Multiplayer)

Add WebSocket functions to `src/utils/cloudWebSocket.js`:

```javascript
// Emit events
export const sendYourGameJoin = (gameId, playerId, playerName) => {
  return emit('yourGame:join', { gameId, playerId, playerName });
};

export const sendYourGameStart = (gameId) => {
  return emit('yourGame:start', { gameId });
};

export const sendYourGameAction = (gameId, playerId, action) => {
  return emit('yourGame:action', { gameId, playerId, action });
};

// Listen to events
export const onYourGamePlayerJoined = (callback) => {
  return on('yourGame:playerJoined', callback);
};

export const onYourGameStarted = (callback) => {
  return on('yourGame:started', callback);
};

export const onYourGameStateUpdate = (callback) => {
  return on('yourGame:stateUpdate', callback);
};
```

### 4. Register Game Mode

Open `src/components/FloatingQuiz.jsx` and find the mode selection rendering.

**Add your mode to ModeSelector:**

The mode is automatically available once you create the component file. FloatingQuiz.jsx dynamically renders game modes, so if you want to add it to the mode selector, update the modes list:

```javascript
const modes = [
  { id: 'quiz', name: 'Quiz', icon: Trophy, color: 'text-os-blue' },
  { id: 'grid', name: 'Grid', icon: Grid3x3, color: 'text-yellow-500' },
  { id: 'tiles', name: 'Tiles', icon: Layers, color: 'text-purple-500' },
  { id: 'yourgame', name: 'Your Game', icon: YourIcon, color: 'text-pink-500' }, // ADD THIS
];
```

**Add mode rendering logic:**

In FloatingQuiz.jsx, add a case for your mode:

```javascript
// In the render section
{gameMode === 'yourgame' && (
  <YourGameMode
    onBack={() => {
      setGameMode(null);
      setGameState(GAME_STATES.MODE_SELECT);
    }}
    currentMachineId={currentMachineId}
    isCentralServerConnected={isCentralServerConnected}
  />
)}
```

### 5. Done!

Your game mode is now available in the Floating Quiz window!

## Available Shared Components

Use these pre-built components to maintain consistency:

### GameBrowser
Browse and create new games.

```jsx
<GameBrowser
  gameMode="yourgame"
  modeTitle="Your Game"
  modeDescription="Brief description"
  availableGames={[]}
  isCentralServerConnected={isCentralServerConnected}
  loadingGames={false}
  onBack={onBack}
  onCreateSinglePlayer={() => {}}
  onCreateMultiplayer={() => {}}
  onJoinGame={(gameId) => {}}
/>
```

### GameLobby
Player waiting room before game starts.

```jsx
<GameLobby
  gameMode="yourgame"
  gameId={gameId}
  lobbyName={lobbyName}
  players={players}
  isHost={isHost}
  hostId={hostId}
  isSinglePlayer={isSinglePlayer}
  currentMachineId={currentMachineId}
  canStart={true}
  onStart={startGame}
  onInviteApp={() => {}}
  onShareWebLink={() => {}}
  onBack={() => {}}
  onUpdateLobbyName={(name) => {}}
  metadata="Game metadata"
  startButtonText="Start Game"
/>
```

### GameResults
Results/scoreboard screen.

```jsx
<GameResults
  gameMode="yourgame"
  players={players}
  scoreHistory={scoreHistory}
  currentMachineId={currentMachineId}
  onBackToGames={() => {}}
  additionalData={{ /* Optional game-specific data */ }}
/>
```

### PlayerList
Reusable player list with status badges.

```jsx
<PlayerList
  players={players}
  currentMachineId={currentMachineId}
  hostId={hostId}
  showScores={true}
  gameId={gameId}
/>
```

### ScoreGraph
Score progression visualization.

```jsx
<ScoreGraph
  scoreHistory={scoreHistory}
  players={players}
  currentMachineId={currentMachineId}
  gameMode="yourgame"
  xAxisLabels={['R1', 'R2', 'R3']} // Optional
/>
```

### ModeSelector
Initial game mode selection (automatically included).

## Game States

Use these standard game states from `src/constants/gameConstants.js`:

```javascript
export const GAME_STATES = {
  MODE_SELECT: 'MODE_SELECT',           // Select Quiz/Grid/Tiles
  GAME_BROWSER: 'GAME_BROWSER',         // Browse/create games
  LOBBY: 'LOBBY',                       // Waiting room
  PLAYING: 'PLAYING',                   // Active gameplay
  RESULTS: 'RESULTS',                   // Scoreboard
  CLOSED: 'CLOSED',                     // Custom selection screens
  QUIZ_TYPE_SELECTION: 'QUIZ_TYPE_SELECTION', // Quiz topics, Grid categories, Tiles grid size
  GRID_BOARD: 'GRID_BOARD',            // Grid board view
  GRID_QUESTION: 'GRID_QUESTION',      // Grid question view
};
```

## Design Tokens

Use these consistent CSS classes for styling:

**Backgrounds:**
- `bg-os-background` - Main background
- `bg-os-card` - Card background
- `bg-os-card-secondary` - Secondary card background
- `bg-os-input-bg` - Input background

**Text:**
- `text-os-text-primary` - Primary text
- `text-os-text-secondary` - Secondary text
- `text-os-text-muted` - Muted text

**Borders:**
- `border-os-border` - Standard border

**Mode-specific colors:**
- Quiz: `bg-os-blue`, `text-os-blue`
- Grid: `bg-yellow-600`, `text-yellow-500`
- Tiles: `bg-purple-600`, `text-purple-500`

## Tips

### Single Player vs Multiplayer

For **single player only** games (offline):
```javascript
if (isSinglePlayer) {
  // Update local state directly
  setYourGameState({ ... });
} else {
  // Send to server
  await sendYourGameAction(gameId, currentMachineId, action);
}
```

For **multiplayer required** games:
```javascript
<GameBrowser
  onCreateSinglePlayer={null} // Disable single player button
  onCreateMultiplayer={() => {}}
/>
```

### Offline Support

To support offline single player (like Tiles mode):
1. Skip WebSocket calls when `isSinglePlayer === true`
2. Validate and update state locally
3. Initialize game state without server communication

Example from Tiles:
```javascript
if (!isSinglePlayer) {
  await sendTilesCreateLobby(...);
} else {
  // Initialize local game state
  setGameState(GAME_STATES.PLAYING);
}
```

### Testing Checklist

- [ ] Single player works offline (if supported)
- [ ] Multiplayer lobby creation works
- [ ] Players can join lobby
- [ ] Game starts correctly
- [ ] Game mechanics work
- [ ] Scoring updates correctly
- [ ] Results screen displays
- [ ] Back navigation works
- [ ] Window resizing doesn't break UI

## Common Patterns

### With Timer
```javascript
useEffect(() => {
  if (gameState !== GAME_STATES.PLAYING) return;

  const interval = setInterval(() => {
    setTimeRemaining(prev => {
      if (prev <= 1) {
        setGameState(GAME_STATES.RESULTS);
        return 0;
      }
      return prev - 1;
    });
  }, 1000);

  return () => clearInterval(interval);
}, [gameState]);
```

### With Score Updates
```javascript
function updateScore(playerId, points) {
  setPlayers(prev => prev.map(p =>
    p.id === playerId ? { ...p, score: (p.score || 0) + points } : p
  ));

  setScoreHistory(prev => ({
    ...prev,
    [playerId]: [...(prev[playerId] || [0]), (prev[playerId]?.slice(-1)[0] || 0) + points]
  }));
}
```

### With Custom Selection Screen
```javascript
if (gameState === GAME_STATES.QUIZ_TYPE_SELECTION) {
  return (
    <div className="flex-1 flex flex-col p-4">
      <div className="mb-4">
        <button onClick={onBack} className="text-xs text-os-text-secondary hover:text-os-text-primary mb-2">
          ← Back to Mode Selection
        </button>
        <h2 className="text-lg font-bold text-os-text-primary">Select Options</h2>
        <p className="text-xs text-os-text-secondary">Choose your settings</p>
      </div>

      {/* Your custom selection UI */}

      <button
        onClick={createLobby}
        className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
      >
        {isSinglePlayer ? 'Start Game' : 'Create Lobby'}
      </button>
    </div>
  );
}
```

## Examples

See these existing game modes for reference:

- **Simple**: `src/components/game-modes/TilesGameMode.jsx` (565 lines)
  - Offline single player support
  - Grid-based gameplay
  - Simple win condition

- **Medium**: `src/components/game-modes/GridGameMode.jsx` (363 lines)
  - Category selection
  - Turn-based gameplay
  - Buzz-in mechanics

- **Complex**: `src/components/game-modes/QuizGameMode.jsx` (356 lines)
  - Multiple quiz types
  - AI-generated content
  - Hints system
  - Timer-based questions

## Architecture Overview

```
FloatingQuiz.jsx (Window Shell)
    ↓
ModeSelector (Quiz/Grid/Tiles/YourGame)
    ↓
YourGameMode.jsx (Self-contained)
    ├── GameBrowser (Browse/create)
    ├── GameLobby (Waiting room)
    ├── Playing (Your game UI)
    └── GameResults (Scoreboard)
```

Each game mode is completely self-contained with its own:
- State management
- Event handlers
- Render logic
- WebSocket listeners

This modular architecture makes it easy to add new games without affecting existing ones.

## Server-Side Implementation

Remember to implement corresponding server handlers in your backend:

```javascript
// Example server handlers
socket.on('yourGame:join', (data) => {
  // Add player to game
  io.to(data.gameId).emit('yourGame:playerJoined', { ... });
});

socket.on('yourGame:start', (data) => {
  // Initialize game state
  io.to(data.gameId).emit('yourGame:started', { ... });
});

socket.on('yourGame:action', (data) => {
  // Process game action
  io.to(data.gameId).emit('yourGame:stateUpdate', { ... });
});
```
