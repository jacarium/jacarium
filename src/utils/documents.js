/**
 * Documents Manager
 * Manages user documents stored in IndexedDB using Dexie
 */

import { db } from '../db/database';
import { generateStableId } from './stableId';

/**
 * Get all documents from database, INCLUDING full `content` bodies.
 * Only use this when the caller actually needs `content` (export,
 * content search, upload). List views should use getDocumentsMetadata().
 * @returns {Promise<Array>} - Array of document objects
 */
export async function getDocuments() {
  try {
    const documents = await db.documents.orderBy('updatedAt').reverse().toArray();
    return documents;
  } catch (error) {
    console.error('Failed to get documents:', error);
    return [];
  }
}

/**
 * Get all documents WITHOUT their `content` field (metadata only).
 *
 * `content` is an arbitrarily large rich-text body; loading it for every
 * document just to render a list (title/category/updatedAt/cloud flags)
 * costs O(n x content-size) memory. IndexedDB has no column projection, so
 * each record is still read once by the cursor, but `content` is dropped
 * immediately instead of being materialized into the returned array (and
 * from there copied into React state, filter chains, etc.).
 *
 * The returned objects OMIT the `content` key entirely (it is not set to
 * `undefined`), so spreading one of them into updateDocument() will never
 * clobber the stored content - updateDocument merges over the existing DB
 * record and an absent key leaves the stored value untouched.
 *
 * Callers that need the body must use getDocuments() or getDocument(id).
 *
 * @returns {Promise<Array>} - Array of document objects (no `content`), newest first
 */
export async function getDocumentsMetadata() {
  try {
    const documents = [];
    await db.documents.orderBy('updatedAt').reverse().each((doc) => {
      const metadata = { ...doc };
      delete metadata.content;
      documents.push(metadata);
    });
    return documents;
  } catch (error) {
    console.error('Failed to get documents metadata:', error);
    return [];
  }
}

/**
 * Get a single document by ID
 * @param {number} id - Document ID
 * @returns {Promise<Object|null>} - Document object or null
 */
export async function getDocument(id) {
  try {
    const document = await db.documents.get(id);
    return document || null;
  } catch (error) {
    console.error('Failed to get document:', error);
    return null;
  }
}

/**
 * Create a new document
 * @param {Object} document - Document object {title, content, category, locked, inCloud, ownerId, cloudLastUpdated}
 * @param {Object} [options]
 * @param {{ add: Function }} [options.writer] - write sink (importDatabase.js
 *   createWriter): the Documents import's dry run passes a no-op writer so
 *   the very same record is built but nothing is stored
 * @returns {Promise<number>} - Created document ID
 */
export async function createDocument(document, { writer = null } = {}) {
  try {
    const newDocument = {
      title: document.title || 'Untitled',
      content: document.content || '',
      category: document.category || 'General',
      locked: document.locked || false,
      updatedAt: Date.now(),
      // Stable cross-machine identity (see stableId.js). Preserved when the
      // document arrives from an import/cloud sync that already carries one
      // (same logical document), minted fresh otherwise. Callers that build
      // a genuinely NEW document (create, duplicate, template-fill) pass no
      // stableId and get a fresh one.
      stableId: (typeof document.stableId === 'string' && document.stableId) || generateStableId(),
      // Preserve cloud fields if present
      ...(document.inCloud !== undefined && { inCloud: document.inCloud }),
      ...(document.ownerId && { ownerId: document.ownerId }),
      ...(document.cloudLastUpdated && { cloudLastUpdated: document.cloudLastUpdated }),
      // cloudDocumentId is the shared Yjs room ID: without it a received cloud
      // document can never join live collaboration (yjsEnabled stays false)
      ...(document.cloudDocumentId && { cloudDocumentId: document.cloudDocumentId }),
      ...(document.permissions !== undefined && { permissions: document.permissions }),
    };

    console.log('[Documents] Creating document:', {
      title: newDocument.title,
      contentLength: newDocument.content?.length || 0,
      hasContent: !!newDocument.content,
      inCloud: newDocument.inCloud,
      ownerId: newDocument.ownerId
    });

    const id = writer ? await writer.add(db.documents, newDocument) : await db.documents.add(newDocument);
    return id;
  } catch (error) {
    console.error('Failed to create document:', error);
    throw error;
  }
}

/**
 * Update an existing document
 * @param {number} id - Document ID
 * @param {Object} updates - Updates to apply {title?, content?, inCloud?, ownerId?, cloudLastUpdated?}
 * @returns {Promise<Object|null>} - Updated document object or null
 */
export async function updateDocument(id, updates) {
  try {
    const existing = await db.documents.get(id);

    if (!existing) {
      console.error('Document not found:', id);
      return null;
    }

    const updated = {
      ...existing,
      ...updates,
      id, // Preserve ID
      updatedAt: Date.now(),
    };

    console.log('[Documents] Updating document:', {
      id,
      title: updated.title,
      contentLength: updated.content?.length || 0,
      hasContent: !!updated.content,
      inCloud: updated.inCloud,
      ownerId: updated.ownerId
    });

    await db.documents.put(updated);
    return updated;
  } catch (error) {
    console.error('Failed to update document:', error);
    return null;
  }
}

/**
 * Delete a document
 * @param {number} id - Document ID
 * @returns {Promise<boolean>} - Success status
 */
export async function deleteDocument(id) {
  try {
    await db.documents.delete(id);
    return true;
  } catch (error) {
    console.error('Failed to delete document:', error);
    return false;
  }
}

/**
 * Get all unique categories
 * @returns {Promise<Array>} - Array of category names
 */
export async function getCategories() {
  try {
    const { getDocumentCategories } = await import('./documentCategories');
    const managedCategories = await getDocumentCategories();

    // Distinct category names straight from the indexed `category` field -
    // no document records (and no `content` bodies) are materialized just to
    // collect the names. Documents with a null/undefined category have no
    // entry in the index; '' is indexed but treated as uncategorized, same
    // as the old filter(Boolean) over a full-table scan.
    const categoryKeys = await db.documents.orderBy('category').uniqueKeys();
    const documentCategories = categoryKeys.filter(key => typeof key === 'string' && key !== '');

    // Merge managed categories with document categories
    const managedCategoryNames = managedCategories.map(cat => cat.name);

    // Uncategorized = any document without a truthy string category. Every
    // categorized document appears in the `category` index with a key other
    // than '', so compare index-backed counts instead of scanning records.
    const totalCount = await db.documents.count();
    const categorizedCount = await db.documents.where('category').notEqual('').count();
    const hasUncategorized = categorizedCount < totalCount;

    // Build result array, keeping managed categories in their position order.
    // Names must be unique: the sidebar keys its rows by name, and a repeated
    // name renders as linked duplicate headers (getDocumentCategories repairs
    // duplicate rows, this is the last line of defense for the list itself).
    const result = [];

    // Add managed categories first (in their defined order)
    managedCategories.forEach(cat => {
      if (!result.includes(cat.name)) {
        result.push(cat.name);
      }
    });

    // Add document categories that aren't managed
    documentCategories.forEach(cat => {
      if (!managedCategoryNames.includes(cat)) {
        result.push(cat);
      }
    });

    // Add "General" category if there are uncategorized documents
    if (hasUncategorized && !result.includes('General')) {
      result.push('General');
    }

    return result;
  } catch (error) {
    console.error('Failed to get categories:', error);
    return ['General'];
  }
}

/**
 * Get documents by category
 * @param {string} category - Category name
 * @returns {Promise<Array>} - Filtered documents
 */
export async function getDocumentsByCategory(category) {
  try {
    const documents = await db.documents.where('category').equals(category).toArray();
    return documents;
  } catch (error) {
    console.error('Failed to get documents by category:', error);
    return [];
  }
}

/**
 * Rename a category across all documents
 *
 * Refused (throws an Error with `code === DUPLICATE_CATEGORY`) when a
 * category with the new name already exists, managed or not: the sidebar
 * identifies categories by name, so a second one with the same name would
 * render as two linked headers instead of one.
 *
 * @param {string} oldName - Current category name
 * @param {string} newName - New category name
 * @returns {Promise<number>} - Number of documents updated
 */
export async function renameCategory(oldName, newName) {
  try {
    const { getDocumentCategories, renameDocumentCategory, DUPLICATE_CATEGORY } = await import('./documentCategories');

    if (oldName !== newName && (await getCategories()).includes(newName)) {
      const error = new Error(`Category "${newName}" already exists.`);
      error.code = DUPLICATE_CATEGORY;
      throw error;
    }

    // Check if this is a managed category (exists in documentCategories table)
    const categories = await getDocumentCategories();
    const category = categories.find(cat => cat.name === oldName);

    if (category) {
      // Use the documentCategories rename function which handles both category and documents
      await renameDocumentCategory(category.id, newName);
    } else {
      // Fallback for uncategorized or legacy categories - just rename documents
      const documents = await db.documents.where('category').equals(oldName).toArray();

      // Don't update updatedAt when renaming category to preserve sort order
      await Promise.all(
        documents.map(doc =>
          db.documents.update(doc.id, { category: newName })
        )
      );
    }

    const updatedDocuments = await db.documents.where('category').equals(newName).toArray();
    return updatedDocuments.length;
  } catch (error) {
    console.error('Failed to rename category:', error);
    throw error;
  }
}

/**
 * Toggle lock status of a document
 * @param {number} id - Document ID
 * @param {boolean} locked - New lock status
 * @returns {Promise<Object|null>} - Updated document object or null
 */
export async function toggleDocumentLock(id, locked) {
  try {
    const existing = await db.documents.get(id);

    if (!existing) {
      console.error('Document not found:', id);
      return null;
    }

    // Don't update updatedAt when toggling lock to preserve sort order
    await db.documents.update(id, { locked });

    return { ...existing, locked };
  } catch (error) {
    console.error('Failed to toggle document lock:', error);
    return null;
  }
}

/**
 * Update document category without changing updatedAt
 * @param {number} id - Document ID
 * @param {string} category - New category
 * @returns {Promise<Object|null>} - Updated document object or null
 */
export async function updateDocumentCategory(id, category) {
  try {
    const existing = await db.documents.get(id);

    if (!existing) {
      console.error('Document not found:', id);
      return null;
    }

    // Don't update updatedAt when changing category to preserve sort order
    await db.documents.update(id, { category });

    return { ...existing, category };
  } catch (error) {
    console.error('Failed to update document category:', error);
    return null;
  }
}
