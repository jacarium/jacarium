/**
 * Cloud Kanban Sync Utility
 * Handles kanban board sync through a central server
 */

import { updateBoard, getCards } from './kanban';
import { getCentralServerUrl, getMachineId, fetchWithTimeout, getCentralAuthHeaders, noCentralError } from './cloudCentralSync';
import { generateUUID } from './uuid';

/**
 * Upload kanban board to central server
 */
export async function uploadBoardToCentral(board) {
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    throw noCentralError();
  }

  const machineId = await getMachineId();
  const cloudLastUpdated = Date.now();

  // Get all cards for this board
  const cards = await getCards(board.id);

  // Generate cloudBoardId if this is the first upload
  const cloudBoardId = board.cloudBoardId || generateUUID();

  // Update board with cloud metadata
  const cloudBoard = {
    ...board,
    inCloud: true,
    ownerId: board.ownerId || machineId,
    cloudBoardId,
    cloudLastUpdated
  };

  console.log('[cloudKanban] Uploading board with cloud metadata:', {
    id: cloudBoard.id,
    title: cloudBoard.title,
    inCloud: cloudBoard.inCloud,
    ownerId: cloudBoard.ownerId,
    cloudBoardId: cloudBoard.cloudBoardId,
    machineId
  });

  // Update locally first
  await updateBoard(board.id, cloudBoard);

  console.log('[cloudKanban] Board updated in IndexedDB with cloud metadata');

  // Try WebSocket first, fallback to HTTP
  try {
    const { isWebSocketConnected, uploadBoardViaWebSocket } = await import('./cloudWebSocket');

    if (isWebSocketConnected()) {
      console.log('[cloudKanban] Using WebSocket for board upload');
      const result = await uploadBoardViaWebSocket(cloudBoard, cards);
      return result;
    }
  } catch (error) {
    console.log('[cloudKanban] WebSocket board upload failed, falling back to HTTP:', error.message);
  }

  // Fallback to HTTP
  const response = await fetchWithTimeout(`${serverUrl}/api/kanban/boards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await getCentralAuthHeaders(serverUrl))
    },
    body: JSON.stringify({
      machine_id: machineId,
      board: cloudBoard,
      cards: cards
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload board: ${error}`);
  }

  return await response.json();
}

/**
 * Remove board from central server
 */
export async function removeBoardFromCentral(board) {
  const serverUrl = getCentralServerUrl();
  if (!serverUrl) {
    throw noCentralError();
  }

  const machineId = await getMachineId();

  // Security check
  if (board.ownerId && board.ownerId !== machineId) {
    throw new Error('Permission denied: Only the board owner can remove it');
  }

  // Try WebSocket first, fallback to HTTP
  try {
    const { isWebSocketConnected, removeBoardViaWebSocket } = await import('./cloudWebSocket');

    if (isWebSocketConnected()) {
      console.log('[cloudKanban] Using WebSocket for board removal');
      await removeBoardViaWebSocket(board.cloudBoardId, board.ownerId);

      // Update locally
      const localBoard = {
        ...board,
        inCloud: false,
        ownerId: undefined,
        cloudBoardId: undefined,
        cloudLastUpdated: undefined
      };
      await updateBoard(board.id, localBoard);

      return { success: true };
    }
  } catch (error) {
    console.log('[cloudKanban] WebSocket board removal failed, falling back to HTTP:', error.message);
  }

  // Fallback to HTTP
  const response = await fetchWithTimeout(
    `${serverUrl}/api/kanban/boards/${board.cloudBoardId}`,
    {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(await getCentralAuthHeaders(serverUrl))
      },
      body: JSON.stringify({ machine_id: machineId })
    }
  );

  if (!response.ok) {
    throw new Error('Failed to remove board from central server');
  }

  // Update locally
  const localBoard = {
    ...board,
    inCloud: false,
    ownerId: undefined,
    cloudBoardId: undefined,
    cloudLastUpdated: undefined
  };
  await updateBoard(board.id, localBoard);

  return { success: true };
}

/**
 * Check if board is owned by current machine or has write permissions
 */
export async function isBoardOwner(board) {
  if (!board.inCloud || !board.ownerId) {
    return true; // Local boards are always owned
  }

  const machineId = await getMachineId();

  // Check if user is the owner
  if (board.ownerId === machineId) {
    return true;
  }

  // Check if user has write permissions
  if (board.permissions && typeof board.permissions === 'object') {
    return board.permissions[machineId] === 'write';
  }

  return false;
}

/**
 * Process incoming board from central server
 */
export async function receiveBoardFromCentral(incomingBoardData) {
  const { getBoards, createBoard, updateBoard, deleteBoard } = await import('./kanban');
  const machineId = await getMachineId();

  const incomingBoard = incomingBoardData.board;
  const incomingCards = incomingBoardData.cards || [];

  // Check if this is a removal message
  if (incomingBoard._type === 'removal') {
    console.log('[CloudKanban] Receiving board removal:', {
      cloudBoardId: incomingBoard.cloudBoardId,
      ownerId: incomingBoard.ownerId
    });

    // Find existing board by cloudBoardId
    const allBoards = await getBoards();
    const existing = allBoards.find(b =>
      b.cloudBoardId && incomingBoard.cloudBoardId &&
      b.cloudBoardId === incomingBoard.cloudBoardId
    );

    if (existing && existing.inCloud) {
      // Check if we're the owner
      const isOwner = existing.ownerId === machineId;

      if (isOwner) {
        // We're the owner - just clear cloud metadata
        const localBoard = {
          ...existing,
          inCloud: false,
          ownerId: undefined,
          cloudBoardId: undefined,
          cloudLastUpdated: undefined
        };
        await updateBoard(existing.id, localBoard);
        console.log('[CloudKanban] Removed cloud metadata from owned board');
        return { action: 'removed_metadata', boardId: existing.id };
      } else {
        // We're not the owner - delete the board
        await deleteBoard(existing.id);
        console.log('[CloudKanban] Deleted cloud board from central server');
        return { action: 'deleted', boardId: existing.id };
      }
    }
    return { action: 'ignored', reason: 'Board not found or not in cloud' };
  }

  // Regular board update
  console.log('[receiveBoardFromCentral] Receiving board:', {
    title: incomingBoard.title,
    ownerId: incomingBoard.ownerId,
    cloudBoardId: incomingBoard.cloudBoardId,
    inCloud: incomingBoard.inCloud,
    cloudLastUpdated: incomingBoard.cloudLastUpdated
  });

  // Find existing board by cloudBoardId (unique identifier)
  const allBoards = await getBoards();
  const existing = allBoards.find(b =>
    b.cloudBoardId && incomingBoard.cloudBoardId &&
    b.cloudBoardId === incomingBoard.cloudBoardId
  );

  if (existing) {
    console.log('[receiveBoardFromCentral] Found existing board by cloudBoardId:', {
      id: existing.id,
      title: existing.title,
      cloudBoardId: existing.cloudBoardId,
      existingTime: existing.cloudLastUpdated,
      incomingTime: incomingBoard.cloudLastUpdated
    });

    // Update if newer
    const existingTime = existing.cloudLastUpdated || 0;
    const incomingTime = incomingBoard.cloudLastUpdated || 0;

    if (incomingTime > existingTime) {
      const updatedBoard = {
        ...incomingBoard,
        id: existing.id,
        inCloud: true,
        updatedAt: new Date()
      };
      await updateBoard(existing.id, updatedBoard);

      // Update cards
      await syncCards(existing.id, incomingCards);

      console.log('[receiveBoardFromCentral] ✓ Board updated successfully');
      return { action: 'updated', boardId: existing.id };
    }
    console.log('[receiveBoardFromCentral] ✗ Rejected: Older or same timestamp');
    return { action: 'rejected', reason: 'Older or same timestamp' };
  } else {
    // Create new
    console.log('[receiveBoardFromCentral] No existing board found, creating new');
    const newBoardData = {
      ...incomingBoard,
      inCloud: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const newBoard = await createBoard(newBoardData);

    // Create cards
    await syncCards(newBoard.id, incomingCards);

    console.log('[receiveBoardFromCentral] ✓ Board created with ID:', newBoard.id);
    return { action: 'created', boardId: newBoard.id };
  }
}

/**
 * Sync cards for a board
 */
async function syncCards(boardId, incomingCards) {
  const { getCards, createCard, updateCard } = await import('./kanban');

  const existingCards = await getCards(boardId);

  // Create or update cards
  for (const incomingCard of incomingCards) {
    const existing = existingCards.find(c =>
      c.title === incomingCard.title &&
      c.status === incomingCard.status
    );

    if (existing) {
      await updateCard(existing.id, {
        ...incomingCard,
        id: existing.id,
        boardId: boardId
      });
    } else {
      await createCard({
        ...incomingCard,
        boardId: boardId
      });
    }
  }
}
