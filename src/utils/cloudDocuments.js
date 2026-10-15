/**
 * Cloud Documents Utility
 * Provides helper functions for cloud document metadata and identification
 */

import { getMachineId } from './cloudCentralSync';

// Re-export the canonical machine ID helper for existing call sites that
// import it from this module.
export { getMachineId };


/**
 * Check if a document is in the cloud
 */
export function isDocumentInCloud(document) {
  return document && document.inCloud === true;
}

/**
 * Check if current user is owner of cloud document or has write permissions
 */
export async function isDocumentOwner(document) {
  if (!document || !document.inCloud) {
    return true; // Local documents are always editable
  }

  const machineId = await getMachineId();

  // Check if user is the owner
  if (document.ownerId === machineId) {
    return true;
  }

  // Check if user has write permissions
  if (document.permissions && typeof document.permissions === 'object') {
    return document.permissions[machineId] === 'write';
  }

  return false;
}

/**
 * Get cloud documents only
 */
export async function getCloudDocuments() {
  try {
    // Metadata is enough here: callers only inspect category/inCloud flags
    const { getDocumentsMetadata } = await import('./documents');
    const allDocs = await getDocumentsMetadata();
    return allDocs.filter(doc => doc.inCloud === true);
  } catch (error) {
    console.error('Failed to get cloud documents:', error);
    return [];
  }
}

/**
 * Get categories that were created by cloud documents
 */
export async function getCloudCategories() {
  try {
    const cloudDocs = await getCloudDocuments();
    const categories = new Set();

    cloudDocs.forEach(doc => {
      if (doc.category) {
        categories.add(doc.category);
      }
    });

    return Array.from(categories);
  } catch (error) {
    console.error('Failed to get cloud categories:', error);
    return [];
  }
}
