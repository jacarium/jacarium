/**
 * Saved Queries Manager
 * Handles localStorage operations for saved JQL queries
 */

const STORAGE_KEY = 'jira_jql_saved_queries';

/**
 * Get all saved queries
 * @returns {Array} - Array of saved queries
 */
export function getSavedQueries() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const queries = JSON.parse(stored);
    return Array.isArray(queries) ? queries : [];
  } catch (error) {
    console.error('Failed to get saved queries:', error);
    return [];
  }
}

/**
 * Save a new query
 * @param {string} name - Query name
 * @param {Object} state - Builder state {rules, logic}
 * @param {string} jql - Generated JQL string
 * @returns {Object} - Saved query object
 */
export function saveQuery(name, state, jql) {
  try {
    const queries = getSavedQueries();

    const newQuery = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      name: name.trim(),
      state,
      jql,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    queries.unshift(newQuery); // Add to beginning
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queries));

    return newQuery;
  } catch (error) {
    console.error('Failed to save query:', error);
    throw error;
  }
}

/**
 * Update an existing query
 * @param {string} id - Query ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} - Updated query or null
 */
export function updateQuery(id, updates) {
  try {
    const queries = getSavedQueries();
    const index = queries.findIndex(q => q.id === id);

    if (index === -1) return null;

    queries[index] = {
      ...queries[index],
      ...updates,
      updatedAt: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(queries));
    return queries[index];
  } catch (error) {
    console.error('Failed to update query:', error);
    return null;
  }
}

/**
 * Delete a saved query
 * @param {string} id - Query ID
 * @returns {boolean} - Success status
 */
export function deleteQuery(id) {
  try {
    const queries = getSavedQueries();
    const filtered = queries.filter(q => q.id !== id);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    return true;
  } catch (error) {
    console.error('Failed to delete query:', error);
    return false;
  }
}

/**
 * Get a single query by ID
 * @param {string} id - Query ID
 * @returns {Object|null} - Query object or null
 */
export function getQueryById(id) {
  const queries = getSavedQueries();
  return queries.find(q => q.id === id) || null;
}

/**
 * Export all saved queries as JSON
 * @returns {string} - JSON string of all queries
 */
export function exportQueries() {
  const queries = getSavedQueries();
  return JSON.stringify(queries, null, 2);
}

/**
 * Import queries from JSON
 * @param {string} jsonString - JSON string of queries
 * @returns {number} - Number of queries imported
 */
export function importQueries(jsonString) {
  try {
    const imported = JSON.parse(jsonString);
    if (!Array.isArray(imported)) {
      throw new Error('Invalid format: expected array');
    }

    const existing = getSavedQueries();
    const merged = [...existing, ...imported];

    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return imported.length;
  } catch (error) {
    console.error('Failed to import queries:', error);
    throw error;
  }
}

/**
 * Clear all saved queries
 * @returns {boolean} - Success status
 */
export function clearAllQueries() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (error) {
    console.error('Failed to clear queries:', error);
    return false;
  }
}
