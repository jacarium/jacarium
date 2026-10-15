// IndexedDB wrapper for custom grids and quizzes (one database per account
// when one is signed in - src/utils/accountStorage.js)
import { scopedDbName } from './accountStorage';

const DB_NAME = 'JacariumDB';
const DB_VERSION = 1;
const GRIDS_STORE = 'customGrids';
const QUIZZES_STORE = 'customQuizzes';

let dbInstance = null;
let dbInstanceName = null;

/**
 * Initialize and open the IndexedDB database
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const name = scopedDbName(DB_NAME);
    if (dbInstance && dbInstanceName === name) {
      resolve(dbInstance);
      return;
    }
    if (dbInstance) { try { dbInstance.close(); } catch { /* already closed */ } dbInstance = null; }
    dbInstanceName = name;

    const request = indexedDB.open(name, DB_VERSION);

    request.onerror = () => {
      console.error('[DB] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      console.log('[DB] Database opened successfully');
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Create custom grids store
      if (!db.objectStoreNames.contains(GRIDS_STORE)) {
        const gridsStore = db.createObjectStore(GRIDS_STORE, { keyPath: 'id' });
        gridsStore.createIndex('name', 'name', { unique: false });
        gridsStore.createIndex('createdAt', 'createdAt', { unique: false });
        console.log('[DB] Created customGrids object store');
      }

      // Create custom quizzes store
      if (!db.objectStoreNames.contains(QUIZZES_STORE)) {
        const quizzesStore = db.createObjectStore(QUIZZES_STORE, { keyPath: 'id' });
        quizzesStore.createIndex('name', 'name', { unique: false });
        quizzesStore.createIndex('createdAt', 'createdAt', { unique: false });
        console.log('[DB] Created customQuizzes object store');
      }
    };
  });
}

/**
 * Get all custom grids
 */
export async function getAllCustomGrids() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([GRIDS_STORE], 'readonly');
      const store = transaction.objectStore(GRIDS_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        console.error('[DB] Failed to get custom grids:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('[DB] Error getting custom grids:', error);
    return [];
  }
}

/**
 * Add a custom grid
 */
export async function addCustomGrid(grid) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([GRIDS_STORE], 'readwrite');
      const store = transaction.objectStore(GRIDS_STORE);
      const request = store.add(grid);

      request.onsuccess = () => {
        console.log('[DB] Custom grid added successfully:', grid.name);
        resolve(request.result);
      };

      request.onerror = () => {
        console.error('[DB] Failed to add custom grid:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('[DB] Error adding custom grid:', error);
    throw error;
  }
}

/**
 * Delete a custom grid
 */
export async function deleteCustomGrid(gridId) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([GRIDS_STORE], 'readwrite');
      const store = transaction.objectStore(GRIDS_STORE);
      const request = store.delete(gridId);

      request.onsuccess = () => {
        console.log('[DB] Custom grid deleted successfully:', gridId);
        resolve();
      };

      request.onerror = () => {
        console.error('[DB] Failed to delete custom grid:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('[DB] Error deleting custom grid:', error);
    throw error;
  }
}

/**
 * Get all custom quizzes
 */
export async function getAllCustomQuizzes() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([QUIZZES_STORE], 'readonly');
      const store = transaction.objectStore(QUIZZES_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        console.error('[DB] Failed to get custom quizzes:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('[DB] Error getting custom quizzes:', error);
    return [];
  }
}

/**
 * Add a custom quiz
 */
export async function addCustomQuiz(quiz) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([QUIZZES_STORE], 'readwrite');
      const store = transaction.objectStore(QUIZZES_STORE);
      const request = store.add(quiz);

      request.onsuccess = () => {
        console.log('[DB] Custom quiz added successfully:', quiz.name);
        resolve(request.result);
      };

      request.onerror = () => {
        console.error('[DB] Failed to add custom quiz:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('[DB] Error adding custom quiz:', error);
    throw error;
  }
}

/**
 * Delete a custom quiz
 */
export async function deleteCustomQuiz(quizId) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([QUIZZES_STORE], 'readwrite');
      const store = transaction.objectStore(QUIZZES_STORE);
      const request = store.delete(quizId);

      request.onsuccess = () => {
        console.log('[DB] Custom quiz deleted successfully:', quizId);
        resolve();
      };

      request.onerror = () => {
        console.error('[DB] Failed to delete custom quiz:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('[DB] Error deleting custom quiz:', error);
    throw error;
  }
}

/**
 * Export all custom content to JSON
 */
export async function exportAllCustomContent() {
  try {
    const grids = await getAllCustomGrids();
    const quizzes = await getAllCustomQuizzes();

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      grids,
      quizzes
    };
  } catch (error) {
    console.error('[DB] Error exporting custom content:', error);
    throw error;
  }
}

/**
 * Import custom content from JSON
 */
export async function importCustomContent(data) {
  try {
    const results = {
      gridsImported: 0,
      quizzesImported: 0,
      errors: []
    };

    // Import grids
    if (data.grids && Array.isArray(data.grids)) {
      for (const grid of data.grids) {
        try {
          // Assign new ID and timestamp to avoid conflicts
          const newGrid = {
            ...grid,
            id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            createdAt: new Date().toISOString()
          };
          await addCustomGrid(newGrid);
          results.gridsImported++;
        } catch (error) {
          console.error('[DB] Failed to import grid:', error);
          results.errors.push(`Grid "${grid.name}": ${error.message}`);
        }
      }
    }

    // Import quizzes
    if (data.quizzes && Array.isArray(data.quizzes)) {
      for (const quiz of data.quizzes) {
        try {
          // Assign new ID and timestamp to avoid conflicts
          const newQuiz = {
            ...quiz,
            id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            createdAt: new Date().toISOString()
          };
          await addCustomQuiz(newQuiz);
          results.quizzesImported++;
        } catch (error) {
          console.error('[DB] Failed to import quiz:', error);
          results.errors.push(`Quiz "${quiz.name}": ${error.message}`);
        }
      }
    }

    return results;
  } catch (error) {
    console.error('[DB] Error importing custom content:', error);
    throw error;
  }
}

/**
 * Clear all custom content (for testing/reset)
 */
export async function clearAllCustomContent() {
  try {
    const db = await openDB();

    await new Promise((resolve, reject) => {
      const transaction = db.transaction([GRIDS_STORE, QUIZZES_STORE], 'readwrite');

      transaction.objectStore(GRIDS_STORE).clear();
      transaction.objectStore(QUIZZES_STORE).clear();

      transaction.oncomplete = () => {
        console.log('[DB] All custom content cleared');
        resolve();
      };

      transaction.onerror = () => {
        console.error('[DB] Failed to clear custom content:', transaction.error);
        reject(transaction.error);
      };
    });
  } catch (error) {
    console.error('[DB] Error clearing custom content:', error);
    throw error;
  }
}
