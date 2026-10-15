/**
 * Kanban Board Utilities
 * Manages kanban boards, columns, and cards using IndexedDB
 */

import { db } from '../db/database';
import { generateStableId } from './stableId';

/**
 * Generate a globally-unique id for a card's Yjs map key, so a shared board
 * is never keyed off the colliding Dexie integer. Same UUID recipe as every
 * other stable record identity in this codebase (see stableId.js).
 */
export function generateCardYjsId() {
  return generateStableId();
}

/**
 * The Yjs map key for a card: the globally-unique yjsId when present,
 * otherwise the stringified Dexie id (legacy cards created before yjsId
 * existed). Shared by useYjsBoard so every read/write of the cards Y.Map uses
 * a stable, collision-free key instead of a per-machine integer.
 */
export function cardYjsKey(card) {
  if (card && card.yjsId != null && card.yjsId !== '') return String(card.yjsId);
  return String(card.id);
}

/**
 * Get all kanban boards
 */
export async function getBoards() {
  try {
    return await db.kanbanBoards.toArray();
  } catch (error) {
    console.error('Error getting boards:', error);
    return [];
  }
}

/**
 * Get a board by ID
 */
export async function getBoard(id) {
  try {
    return await db.kanbanBoards.get(id);
  } catch (error) {
    console.error('Error getting board:', error);
    return null;
  }
}

/**
 * Create a new board
 */
export async function createBoard(board) {
  try {
    const newBoard = {
      ...board,
      category: board.category || 'General',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const id = await db.kanbanBoards.add(newBoard);
    return { ...newBoard, id };
  } catch (error) {
    console.error('Error creating board:', error);
    throw error;
  }
}

/**
 * Update a board
 */
export async function updateBoard(id, updates) {
  try {
    await db.kanbanBoards.update(id, {
      ...updates,
      updatedAt: new Date()
    });
    return await getBoard(id);
  } catch (error) {
    console.error('Error updating board:', error);
    throw error;
  }
}

/**
 * Delete a board
 */
export async function deleteBoard(id) {
  try {
    // Delete all cards in this board
    await db.kanbanCards.where('boardId').equals(id).delete();
    // Delete the board
    await db.kanbanBoards.delete(id);
  } catch (error) {
    console.error('Error deleting board:', error);
    throw error;
  }
}

/**
 * Duplicate a board with all its cards
 */
export async function duplicateBoard(id) {
  try {
    // Get the original board
    const originalBoard = await getBoard(id);
    if (!originalBoard) {
      throw new Error('Board not found');
    }

    // Get all cards from the original board
    const originalCards = await getCards(id);

    // Create new board (without cloud properties)
    const newBoard = {
      title: `${originalBoard.title} (Copy)`,
      columns: originalBoard.columns,
      category: originalBoard.category,
      // Don't copy cloud properties - this is a local duplicate
      inCloud: false,
      ownerId: null,
      cloudBoardId: null,
      cloudLastUpdated: null,
      permissions: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const newBoardId = await db.kanbanBoards.add(newBoard);

    // Duplicate all cards. A duplicate is a NEW card, so it gets its own fresh
    // yjsId (never reuse the source card's Yjs key).
    for (const card of originalCards) {
      const newCard = {
        boardId: newBoardId,
        yjsId: generateCardYjsId(),
        title: card.title,
        description: card.description,
        status: card.status,
        position: card.position,
        priority: card.priority,
        labels: card.labels,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      await db.kanbanCards.add(newCard);
    }

    return { ...newBoard, id: newBoardId };
  } catch (error) {
    console.error('Error duplicating board:', error);
    throw error;
  }
}

/**
 * Get all cards for a board
 */
export async function getCards(boardId) {
  try {
    return await db.kanbanCards.where('boardId').equals(boardId).toArray();
  } catch (error) {
    console.error('Error getting cards:', error);
    return [];
  }
}

/**
 * Get a card by ID
 */
export async function getCard(id) {
  try {
    return await db.kanbanCards.get(id);
  } catch (error) {
    console.error('Error getting card:', error);
    return null;
  }
}

/**
 * Create a new card
 */
export async function createCard(card) {
  try {
    const newCard = {
      ...card,
      // Globally-unique identity for the card's Yjs map key on shared/cloud
      // boards. The Dexie `id` is a per-machine auto-increment integer, so two
      // collaborators creating a card at nearly the same time both mint the
      // same next integer locally and collide on the same Y.Map key -> one
      // card silently overwrites the other for everyone. `yjsId` is a UUID
      // generated once at creation, used ONLY as the Yjs key; the Dexie `id`
      // and everything keyed off it (React keys, drag identity, IndexedDB
      // primary key) are untouched. Preserved if the caller already supplied
      // one (e.g. a card mirrored down from the server).
      yjsId: card.yjsId || generateCardYjsId(),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const id = await db.kanbanCards.add(newCard);

    // Update board's updatedAt timestamp
    if (card.boardId) {
      await db.kanbanBoards.update(card.boardId, { updatedAt: new Date() });
    }

    return { ...newCard, id };
  } catch (error) {
    console.error('Error creating card:', error);
    throw error;
  }
}

/**
 * Update a card
 */
export async function updateCard(id, updates) {
  try {
    // Get the card to find its boardId
    const card = await db.kanbanCards.get(id);

    await db.kanbanCards.update(id, {
      ...updates,
      updatedAt: new Date()
    });

    // Update board's updatedAt timestamp
    if (card && card.boardId) {
      await db.kanbanBoards.update(card.boardId, { updatedAt: new Date() });
    }

    return await getCard(id);
  } catch (error) {
    console.error('Error updating card:', error);
    throw error;
  }
}

/**
 * Delete a card
 */
export async function deleteCard(id) {
  try {
    // Get the card to find its boardId
    const card = await db.kanbanCards.get(id);

    await db.kanbanCards.delete(id);

    // Update board's updatedAt timestamp
    if (card && card.boardId) {
      await db.kanbanBoards.update(card.boardId, { updatedAt: new Date() });
    }
  } catch (error) {
    console.error('Error deleting card:', error);
    throw error;
  }
}

/**
 * Move card to a different status/column
 */
export async function moveCard(cardId, newStatus, newPosition) {
  try {
    // Get the card to find its boardId
    const card = await db.kanbanCards.get(cardId);

    await db.kanbanCards.update(cardId, {
      status: newStatus,
      position: newPosition,
      updatedAt: new Date()
    });

    // Update board's updatedAt timestamp
    if (card && card.boardId) {
      await db.kanbanBoards.update(card.boardId, { updatedAt: new Date() });
    }

    return await getCard(cardId);
  } catch (error) {
    console.error('Error moving card:', error);
    throw error;
  }
}

/**
 * Reorder cards in a column
 */
export async function reorderCards(boardId, status, cardIds) {
  try {
    const updates = cardIds.map((cardId, index) =>
      db.kanbanCards.update(cardId, { position: index, updatedAt: new Date() })
    );
    await Promise.all(updates);

    // Update board's updatedAt timestamp
    if (boardId) {
      await db.kanbanBoards.update(boardId, { updatedAt: new Date() });
    }
  } catch (error) {
    console.error('Error reordering cards:', error);
    throw error;
  }
}

/**
 * Get default columns
 */
export function getDefaultColumns() {
  return [
    { id: 'todo', title: 'To Do', color: '#94a3b8' },
    { id: 'in-progress', title: 'In Progress', color: '#3b82f6' },
    { id: 'review', title: 'Review', color: '#f59e0b' },
    { id: 'done', title: 'Done', color: '#10b981' }
  ];
}

/**
 * Initialize default board if none exists
 */
export async function initializeDefaultBoard() {
  try {
    const boards = await getBoards();
    if (boards.length === 0) {
      const defaultBoard = {
        title: 'My Kanban Board',
        description: 'Default kanban board',
        category: 'General',
        columns: getDefaultColumns()
      };
      return await createBoard(defaultBoard);
    }
    return boards[0];
  } catch (error) {
    console.error('Error initializing default board:', error);
    throw error;
  }
}

/**
 * Get all unique categories from boards
 */
export async function getCategories() {
  try {
    const boards = await getBoards();
    const categories = new Set();
    boards.forEach(board => {
      const category = board.category || 'General';
      categories.add(category);
    });
    return Array.from(categories).sort();
  } catch (error) {
    console.error('Error getting categories:', error);
    return [];
  }
}

/**
 * Rename a category
 */
export async function renameCategory(oldName, newName) {
  try {
    const boards = await db.kanbanBoards.where('category').equals(oldName).toArray();
    const updates = boards.map(board =>
      db.kanbanBoards.update(board.id, {
        category: newName,
        updatedAt: new Date()
      })
    );
    await Promise.all(updates);
  } catch (error) {
    console.error('Error renaming category:', error);
    throw error;
  }
}

/**
 * Update board category
 */
export async function updateBoardCategory(boardId, newCategory) {
  try {
    await db.kanbanBoards.update(boardId, {
      category: newCategory || 'General',
      updatedAt: new Date()
    });
    return await getBoard(boardId);
  } catch (error) {
    console.error('Error updating board category:', error);
    throw error;
  }
}
