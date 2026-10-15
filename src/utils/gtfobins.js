/**
 * GTFOBins data manager
 *
 * Manages the GTFOBins reference data (functions + executables) stored in
 * IndexedDB via Dexie. The data lives solely in IndexedDB — there is no
 * bundled fallback dataset. A fresh install therefore starts empty; the tables
 * are populated either by hand (adding functions/executables through the tool
 * UI) or by importing a full-database export that contains GTFOBins data via
 * "File > Database > Import" (see src/utils/importDatabase.js, which handles
 * gtfobinsFunctions / gtfobinsExecutables / gtfobinsContexts). All adds, edits
 * and deletes persist.
 *
 * Data shapes
 * -----------
 * Function row:
 *   { id, funcId, label, description, sortOrder, isBuiltIn }
 *
 * Executable row:
 *   {
 *     id,
 *     name,
 *     comment,        // overall description of the binary (may be '')
 *     alias,          // string | null — this binary is an alias of another
 *     functionIds,    // string[] — sorted, multiEntry-indexed, kept in sync
 *     functions: {    // funcId -> array of entries
 *       [funcId]: [ { code, comment?, version?, from?, binary?, contexts? } ]
 *     },
 *     isBuiltIn,
 *     updatedAt,
 *   }
 */

import { db } from '../db/database';

const now = () => new Date().toISOString();

// ---- Functions --------------------------------------------------------------

/**
 * Get all functions, ordered by sortOrder then label.
 * @returns {Promise<Array>}
 */
export async function getGtfobinsFunctions() {
  try {
    const functions = await db.gtfobinsFunctions.toArray();
    return functions.sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.label.localeCompare(b.label)
    );
  } catch (error) {
    console.error('Failed to get GTFOBins functions:', error);
    return [];
  }
}

// ---- Contexts (read-only reference set) -------------------------------------

/**
 * Get all contexts, ordered by their seeded sortOrder (upstream order) then
 * label. Contexts are a closed set — read-only, no CRUD.
 * @returns {Promise<Array>}
 */
export async function getGtfobinsContexts() {
  try {
    const contexts = await db.gtfobinsContexts.toArray();
    return contexts.sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.label.localeCompare(b.label)
    );
  } catch (error) {
    console.error('Failed to get GTFOBins contexts:', error);
    return [];
  }
}

/**
 * Create a custom function. funcId is derived from the label (slug) unless
 * explicitly provided; must be unique.
 * @param {{ funcId?: string, label: string, description?: string }} data
 * @returns {Promise<number>} new row id
 */
export async function createGtfobinsFunction(data) {
  const label = (data.label || '').trim();
  if (!label) throw new Error('Function label is required');

  const funcId = (data.funcId || slugify(label)).trim();
  if (!funcId) throw new Error('Function id is required');

  const existing = await db.gtfobinsFunctions.where('funcId').equals(funcId).first();
  if (existing) throw new Error(`A function with id "${funcId}" already exists`);

  const maxOrder = await db.gtfobinsFunctions
    .orderBy('sortOrder')
    .last()
    .then((row) => (row && typeof row.sortOrder === 'number' ? row.sortOrder : 0));

  return db.gtfobinsFunctions.add({
    funcId,
    label,
    description: (data.description || '').trim(),
    sortOrder: maxOrder + 1,
    isBuiltIn: 0,
  });
}

/**
 * Update a function's label/description (funcId is immutable — it is
 * referenced by executables).
 * @param {number} id
 * @param {{ label?: string, description?: string }} updates
 */
export async function updateGtfobinsFunction(id, updates) {
  const patch = {};
  if (typeof updates.label === 'string') patch.label = updates.label.trim();
  if (typeof updates.description === 'string') patch.description = updates.description.trim();
  return db.gtfobinsFunctions.update(id, patch);
}

/**
 * Delete a function. Also detaches it from every executable that references it.
 * @param {number} id
 */
export async function deleteGtfobinsFunction(id) {
  const fn = await db.gtfobinsFunctions.get(id);
  if (!fn) return;

  await db.transaction('rw', db.gtfobinsFunctions, db.gtfobinsExecutables, async () => {
    // Detach from every executable that supports it.
    const affected = await db.gtfobinsExecutables
      .where('functionIds')
      .equals(fn.funcId)
      .toArray();
    for (const exe of affected) {
      const functions = { ...exe.functions };
      delete functions[fn.funcId];
      await db.gtfobinsExecutables.update(exe.id, {
        functions,
        functionIds: Object.keys(functions).sort((a, b) => a.localeCompare(b)),
        updatedAt: now(),
      });
    }
    await db.gtfobinsFunctions.delete(id);
  });
}

// ---- Executables ------------------------------------------------------------

/**
 * Get all executables ordered by name.
 * @returns {Promise<Array>}
 */
export async function getGtfobinsExecutables() {
  try {
    return await db.gtfobinsExecutables.orderBy('name').toArray();
  } catch (error) {
    console.error('Failed to get GTFOBins executables:', error);
    return [];
  }
}

/**
 * Get executables that support a given function (indexed multiEntry query),
 * ordered by name.
 * @param {string} funcId
 * @returns {Promise<Array>}
 */
export async function getGtfobinsExecutablesByFunction(funcId) {
  try {
    const rows = await db.gtfobinsExecutables.where('functionIds').equals(funcId).toArray();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error('Failed to get GTFOBins executables by function:', error);
    return [];
  }
}

/**
 * Count executables per function id, for the Functions table.
 * @returns {Promise<Object>} map of funcId -> count
 */
export async function getGtfobinsFunctionCounts() {
  try {
    const executables = await db.gtfobinsExecutables.toArray();
    const counts = {};
    for (const exe of executables) {
      for (const funcId of exe.functionIds || []) {
        counts[funcId] = (counts[funcId] || 0) + 1;
      }
    }
    return counts;
  } catch (error) {
    console.error('Failed to count GTFOBins functions:', error);
    return {};
  }
}

/**
 * Normalize the `functions` object and derive functionIds from its keys.
 */
function withDerivedFunctionIds(functions) {
  const clean = functions && typeof functions === 'object' ? functions : {};
  return {
    functions: clean,
    functionIds: Object.keys(clean).sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Create a new executable.
 * @param {{ name: string, comment?: string, alias?: string|null, functions?: Object }} data
 * @returns {Promise<number>} new row id
 */
export async function createGtfobinsExecutable(data) {
  const name = (data.name || '').trim();
  if (!name) throw new Error('Executable name is required');

  const existing = await db.gtfobinsExecutables.where('name').equals(name).first();
  if (existing) throw new Error(`An executable named "${name}" already exists`);

  const { functions, functionIds } = withDerivedFunctionIds(data.functions);

  return db.gtfobinsExecutables.add({
    name,
    comment: (data.comment || '').trim(),
    alias: data.alias ? String(data.alias).trim() : null,
    functions,
    functionIds,
    isBuiltIn: 0,
    updatedAt: now(),
  });
}

/**
 * Update an executable. If `functions` is provided, functionIds are re-derived.
 * @param {number} id
 * @param {Object} updates
 */
export async function updateGtfobinsExecutable(id, updates) {
  const patch = { updatedAt: now() };

  if (typeof updates.name === 'string') {
    const name = updates.name.trim();
    if (!name) throw new Error('Executable name is required');
    const clash = await db.gtfobinsExecutables.where('name').equals(name).first();
    if (clash && clash.id !== id) throw new Error(`An executable named "${name}" already exists`);
    patch.name = name;
  }
  if (typeof updates.comment === 'string') patch.comment = updates.comment.trim();
  if ('alias' in updates) patch.alias = updates.alias ? String(updates.alias).trim() : null;
  if (updates.functions) {
    const { functions, functionIds } = withDerivedFunctionIds(updates.functions);
    patch.functions = functions;
    patch.functionIds = functionIds;
  }

  return db.gtfobinsExecutables.update(id, patch);
}

/**
 * Delete an executable.
 * @param {number} id
 */
export async function deleteGtfobinsExecutable(id) {
  return db.gtfobinsExecutables.delete(id);
}

/**
 * Attach (or replace) the entries for a single function on an executable.
 * @param {number} id
 * @param {string} funcId
 * @param {Array} entries
 */
export async function setExecutableFunctionEntries(id, funcId, entries) {
  const exe = await db.gtfobinsExecutables.get(id);
  if (!exe) throw new Error('Executable not found');
  const functions = { ...exe.functions, [funcId]: entries };
  return updateGtfobinsExecutable(id, { functions });
}

/**
 * Remove a function from an executable entirely.
 * @param {number} id
 * @param {string} funcId
 */
export async function removeExecutableFunction(id, funcId) {
  const exe = await db.gtfobinsExecutables.get(id);
  if (!exe) throw new Error('Executable not found');
  const functions = { ...exe.functions };
  delete functions[funcId];
  return updateGtfobinsExecutable(id, { functions });
}

/**
 * Build an empty function entry (used when adding a new capability in the UI).
 * @returns {Object}
 */
export function emptyEntry() {
  return {
    code: '',
    comment: '',
    contexts: { sudo: null, suid: null, unprivileged: null },
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
