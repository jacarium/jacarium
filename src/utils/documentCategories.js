import { db } from '../db/database';

/**
 * Error code carried by the Error thrown when a create/rename would leave two
 * managed categories with the same name. Callers match on `error.code` so
 * they can show a "Duplicate Category" alert instead of a generic failure.
 */
export const DUPLICATE_CATEGORY = 'DUPLICATE_CATEGORY';

function duplicateCategoryError(name) {
  const error = new Error(`Category "${name}" already exists.`);
  error.code = DUPLICATE_CATEGORY;
  return error;
}

/**
 * Get all document categories
 *
 * Self-heals duplicate rows: categories are referenced by NAME everywhere
 * (documents.category, the sidebar's expanded-state list, React list keys),
 * so two managed rows with the same name render as two linked headers and
 * leak an extra orphan row on every later list change. Older builds could
 * write such a pair (rename onto an existing name, double-submitted create),
 * and the rows survive restarts. The duplicate check is O(n) on the array we
 * already fetched, so the normal case costs nothing extra.
 */
export async function getDocumentCategories() {
  const categories = await db.documentCategories.orderBy('position').toArray();
  if (!hasDuplicateNames(categories)) {
    return categories;
  }
  // (Two concurrent readers can both see the duplicates; the second repair
  // then finds nothing left to remove.)
  const removed = await repairDuplicateDocumentCategories();
  if (removed > 0) {
    console.warn(`[DocumentCategories] Removed ${removed} duplicate category row(s)`);
  }
  return await db.documentCategories.orderBy('position').toArray();
}

function hasDuplicateNames(categories) {
  const seen = new Set();
  for (const category of categories) {
    if (seen.has(category.name)) return true;
    seen.add(category.name);
  }
  return false;
}

/**
 * Collapse managed categories that share a name down to one row per name.
 *
 * For each duplicated name the row with the lowest id (the one created
 * first) survives; the others are deleted. The survivor keeps its own
 * position and inherits an icon from a deleted twin only if it has none
 * itself. Documents are never touched: they point at the category by name,
 * and that name still exists afterwards, so every document stays exactly
 * where the user sees it.
 *
 * @returns {Promise<number>} number of rows deleted
 */
export async function repairDuplicateDocumentCategories() {
  return await db.transaction('rw', db.documentCategories, async () => {
    const rows = await db.documentCategories.toArray();
    rows.sort((a, b) => a.id - b.id);

    const survivors = new Map(); // name -> surviving row
    const deleteIds = [];
    const iconFixes = new Map(); // survivor id -> icon

    for (const row of rows) {
      const survivor = survivors.get(row.name);
      if (!survivor) {
        survivors.set(row.name, row);
        continue;
      }
      deleteIds.push(row.id);
      if (!survivor.icon && row.icon && !iconFixes.has(survivor.id)) {
        iconFixes.set(survivor.id, row.icon);
      }
    }

    for (const [id, icon] of iconFixes) {
      await db.documentCategories.update(id, { icon });
    }
    if (deleteIds.length > 0) {
      await db.documentCategories.bulkDelete(deleteIds);
    }
    return deleteIds.length;
  });
}

/**
 * Get a single document category by ID
 */
export async function getDocumentCategory(id) {
  return await db.documentCategories.get(id);
}

/**
 * Create a new document category
 *
 * Idempotent by name: if a managed category with this name already exists
 * the existing row is returned (with `created: false`) and nothing is
 * written. The lookup and the insert run in one readwrite transaction, so
 * two concurrent calls with the same name (a double-submitted "New Category"
 * modal) can never both insert - the second one waits for the first to
 * commit and then finds its row.
 */
export async function createDocumentCategory(data) {
  const now = new Date().toISOString();

  return await db.transaction('rw', db.documentCategories, async () => {
    const allCategories = await db.documentCategories.toArray();

    const existing = allCategories.find(c => c.name === data.name);
    if (existing) {
      return { ...existing, created: false };
    }

    // Get the highest position
    const maxPosition = allCategories.length > 0
      ? Math.max(...allCategories.map(c => c.position || 0))
      : -1;

    const category = {
      name: data.name,
      icon: data.icon || null,  // Icon name (e.g., 'briefcase', 'robot', 'archive')
      position: maxPosition + 1,
      createdAt: now,
      updatedAt: now,
    };

    const id = await db.documentCategories.add(category);
    return { ...category, id, created: true };
  });
}

/**
 * Update an existing document category
 */
export async function updateDocumentCategory(id, updates) {
  const now = new Date().toISOString();
  await db.documentCategories.update(id, {
    ...updates,
    updatedAt: now,
  });
  return await getDocumentCategory(id);
}

/**
 * Delete a document category
 * Note: This does NOT delete documents in this category,
 * they will just become uncategorized (category = null)
 */
export async function deleteDocumentCategory(id) {
  const category = await getDocumentCategory(id);
  if (!category) return;

  // Update all documents with this category to have no category
  // (metadata only: we just need id + category to re-tag them)
  const { updateDocument, getDocumentsMetadata } = await import('./documents');
  const allDocs = await getDocumentsMetadata();
  const docsInCategory = allDocs.filter(doc => doc.category === category.name);

  for (const doc of docsInCategory) {
    await updateDocument(doc.id, { category: null });
  }

  await db.documentCategories.delete(id);
}

/**
 * Rename a document category
 * Updates all documents using this category name
 *
 * Throws an Error with `code === DUPLICATE_CATEGORY` when another managed
 * category already has the new name: renaming onto it would leave two rows
 * with the same name (see getDocumentCategories), so the rename is refused
 * and nothing is changed.
 */
export async function renameDocumentCategory(id, newName) {
  const category = await getDocumentCategory(id);
  if (!category) return;

  const oldName = category.name;
  if (oldName === newName) return;

  const clash = await db.documentCategories.where('name').equals(newName).first();
  if (clash && clash.id !== id) {
    throw duplicateCategoryError(newName);
  }

  // Update the category itself
  await updateDocumentCategory(id, { name: newName });

  // Update all documents with this category
  // (metadata only: we just need id + category to re-tag them)
  const { updateDocument, getDocumentsMetadata } = await import('./documents');
  const allDocs = await getDocumentsMetadata();
  const docsInCategory = allDocs.filter(doc => doc.category === oldName);

  for (const doc of docsInCategory) {
    await updateDocument(doc.id, { category: newName });
  }
}

/**
 * Reorder document categories
 */
export async function reorderDocumentCategories(categoryIds) {
  for (let i = 0; i < categoryIds.length; i++) {
    await db.documentCategories.update(categoryIds[i], { position: i });
  }
}
