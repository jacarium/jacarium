import { useCallback } from 'react';
import JSZip from 'jszip';
import { stringifyToParts } from '../utils/incrementalJson';
import { createYielder } from '../utils/yieldToUI';
import { formatBytes, downloadBlob, dateStamp } from '../utils/exportHelpers';
import { isNativePdfExportAvailable, exportDocumentToPDFNative } from '../utils/pdfExportNative';
import { desktopOnly } from '../utils/platform';

/**
 * Every export function below accepts an optional `onProgress` callback and
 * reports progress in the shape ExportProgressModal consumes:
 *   { step, steps, label, current, total, percent, indeterminate, log, logType }
 * (all fields optional). Long synchronous loops yield to the event loop on a
 * time budget (createYielder) so the modal can actually repaint - see
 * src/utils/yieldToUI.js for why a plain `await` is not enough.
 */

/**
 * Sanitize a name for use as a file or directory entry inside an export ZIP.
 * Strips illegal filesystem characters, replaces whitespace runs with a single
 * underscore, collapses repeated underscores, and trims leading/trailing ones.
 * @param {string} name - Raw name
 * @returns {string} Sanitized name safe for Linux/macOS filesystems
 */
function sanitizeZipEntryName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Wrap an optional progress callback so call sites can report unconditionally.
 * @param {Function|null} onProgress
 * @returns {Function}
 */
function makeReporter(onProgress) {
  return (update) => {
    if (onProgress) onProgress(update);
  };
}

/**
 * Re-read documents from the database so the export carries the latest
 * content (the sidebar's list may hold stale/metadata-only copies).
 * Reads stay parallel; `onEach(done, total)` fires as each one lands.
 * @param {object} db - Dexie database
 * @param {Array} docs - Documents (need `.id`)
 * @param {Function|null} onEach
 * @returns {Promise<Array>}
 */
async function fetchFreshDocuments(db, docs, onEach = null) {
  let done = 0;
  return Promise.all(
    docs.map(async (doc) => {
      const fresh = await db.documents.get(doc.id);
      done += 1;
      if (onEach) onEach(done, docs.length);
      return fresh || doc;
    })
  );
}

/**
 * Rewrite `attachment:` image links in markdown to `images/<name>` paths for
 * external editors, collecting the referenced media blobs into `usedImages`
 * (sanitized filename -> blob) so the caller can add them to the ZIP.
 * @param {string} content - Markdown source
 * @param {Map<string, object>} mediaByFilename - media records by filename
 * @param {Map<string, Blob>} usedImages - accumulator, mutated
 * @returns {string} Rewritten markdown
 */
function rewriteAttachmentLinks(content, mediaByFilename, usedImages) {
  return content.replace(/!\[([^\]]*)\]\(attachment:([^)]+)\)/g, (match, alt, imageFilename) => {
    // Optional trailing ?width= resize suffix (see interactiveMarkdown.js):
    // strip it before the media lookup, re-append it to the rewritten link
    const widthMatch = imageFilename.match(/\?width=(\d+)(px|%)?$/);
    const widthSuffix = widthMatch ? widthMatch[0] : '';
    const baseFilename = widthMatch
      ? imageFilename.slice(0, widthMatch.index)
      : imageFilename;
    const sanitizedImageName = sanitizeZipEntryName(baseFilename);
    const mediaItem = mediaByFilename.get(baseFilename);
    if (mediaItem && !usedImages.has(sanitizedImageName)) {
      usedImages.set(sanitizedImageName, mediaItem.blob);
    }
    return `![${alt}](images/${sanitizedImageName}${widthSuffix})`;
  });
}

/**
 * Add the collected image blobs to `parentFolder/images/`.
 * @param {JSZip} parentFolder
 * @param {Map<string, Blob>} usedImages
 */
function addImagesFolder(parentFolder, usedImages) {
  if (usedImages.size === 0) return;
  const imagesFolder = parentFolder.folder('images');
  for (const [imageName, blob] of usedImages) {
    // Store blob directly - JSZip handles it efficiently
    imagesFolder.file(imageName, blob);
  }
}

/**
 * Generate the ZIP blob, driving the progress bar from JSZip's own
 * per-chunk onUpdate callback (percent + current file).
 * @param {JSZip} zip
 * @param {Function} report
 * @param {number} step - Step number to report under
 * @param {number} steps - Total steps
 * @returns {Promise<Blob>}
 */
function generateZipBlob(zip, report, step, steps) {
  return zip.generateAsync({ type: 'blob' }, (meta) => {
    report({
      step,
      steps,
      label: meta.currentFile ? `Compressing ${meta.currentFile}` : 'Compressing',
      percent: meta.percent,
    });
  });
}

/**
 * Custom hook for import/export functionality
 * @returns {object} Import/export functions
 */
export function useImportExport() {
  /**
   * Export data to JSON file
   * @param {*} data - Data to export
   * @param {string} filename - Name of the file (without extension)
   * @param {object} options - Export options
   * @param {boolean} [options.addTimestamp=true]
   * @param {boolean} [options.prettify=true]
   * @param {Function} [options.onProgress] - progress callback (see top of file)
   * @returns {Promise<boolean>}
   */
  const exportToJSON = useCallback(async (data, filename, options = {}) => {
    try {
      const {
        addTimestamp = true,
        prettify = true,
        onProgress = null,
      } = options;
      const report = makeReporter(onProgress);
      const writeLabel = 'Writing JSON';

      // Serialize incrementally (per top-level element) so large arrays of
      // documents yield to the UI as they go; the parts feed Blob directly
      const total = Array.isArray(data) ? data.length : 0;
      report({ label: writeLabel, current: 0, total, indeterminate: total === 0 });
      const parts = await stringifyToParts(data, {
        indent: prettify ? 2 : 0,
        yielder: createYielder(),
        onProgress: (current, count) => report({ label: writeLabel, current, total: count }),
      });

      report({ label: 'Saving file', indeterminate: true });
      const blob = new Blob(parts, { type: 'application/json' });

      // Add timestamp to filename if requested
      const timestamp = addTimestamp ? `-${dateStamp()}` : '';
      const downloadName = `${filename}${timestamp}.json`;
      downloadBlob(blob, downloadName);

      report({
        label: 'Saved',
        percent: 100,
        log: `Saved ${downloadName} (${formatBytes(blob.size)})`,
        logType: 'success',
      });
      return true;
    } catch (error) {
      console.error('Failed to export to JSON:', error);
      throw error;
    }
  }, []);

  /**
   * Import data from JSON file
   * @param {object} options - Import options
   * @returns {Promise<*>} Imported data
   */
  const importFromJSON = useCallback((options = {}) => {
    const {
      accept = '.json',
      multiple = false,
      validate = null,
    } = options;

    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;

      input.onchange = async (e) => {
        try {
          const files = Array.from(e.target.files);
          if (files.length === 0) {
            resolve(null);
            return;
          }

          if (!multiple) {
            // Single file import
            const file = files[0];
            const reader = new FileReader();

            reader.onload = async (event) => {
              try {
                const data = JSON.parse(event.target.result);

                // Validate if validation function provided
                if (validate && !validate(data)) {
                  reject(new Error('Invalid file format'));
                  return;
                }

                resolve(data);
              } catch (error) {
                reject(new Error('Failed to parse JSON: ' + error.message));
              }
            };

            reader.onerror = () => {
              reject(new Error('Failed to read file'));
            };

            reader.readAsText(file);
          } else {
            // Multiple file import
            const results = [];

            for (const file of files) {
              const reader = new FileReader();
              const data = await new Promise((res, rej) => {
                reader.onload = (event) => {
                  try {
                    const parsed = JSON.parse(event.target.result);
                    if (validate && !validate(parsed)) {
                      rej(new Error('Invalid file format'));
                      return;
                    }
                    res(parsed);
                  } catch (error) {
                    rej(error);
                  }
                };
                reader.onerror = () => rej(new Error('Failed to read file'));
                reader.readAsText(file);
              });
              results.push(data);
            }

            resolve(results);
          }
        } catch (error) {
          reject(error);
        }
      };

      input.click();
    });
  }, []);

  /**
   * Re-read documents from the database so an export carries their content.
   * The documents list the sidebar renders comes from getDocumentsMetadata()
   * (content stripped to keep the list cheap), so JSON/Base64 exports MUST
   * go through this before serializing or they ship content-less records.
   * The ZIP/PDF exporters already do their own fresh read.
   * @param {Array} docs - Documents (need `.id`)
   * @param {Function|null} onProgress - progress callback (see top of file)
   * @returns {Promise<Array>} Documents with content
   */
  const loadDocumentsWithContent = useCallback(async (docs, onProgress = null) => {
    const report = makeReporter(onProgress);
    const label = 'Loading documents';
    report({ label, current: 0, total: docs.length });
    const { db } = await import('../db/database');
    return fetchFreshDocuments(db, docs, (current, total) => report({ label, current, total }));
  }, []);

  /**
   * Export items filtered by category
   * @param {Array} items - All items
   * @param {string} categoryName - Category to export
   * @param {string} filename - Base filename
   * @param {object} options - Export options (see exportToJSON)
   */
  const exportCategory = useCallback((items, categoryName, filename, options = {}) => {
    const categoryItems = items.filter(item => (item.category || 'General') === categoryName);

    // Category names are free text (any character the user typed): strip
    // what no filesystem accepts the same way ZIP entry names are
    // sanitized, so the download name is predictable instead of being
    // rewritten by the browser/Electron download manager ("Ops/Prod" ->
    // "ops-prod", not "ops_prod" or a nested path).
    const sanitizedCategory = categoryName
      .toLowerCase()
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'category';
    const filenameWithCategory = `${filename}-${sanitizedCategory}`;

    return exportToJSON(categoryItems, filenameWithCategory, options);
  }, [exportToJSON]);

  /**
   * Bulk import items with progress tracking
   * @param {Array} items - Items to import
   * @param {Function} createFn - Function to create each item
   * @param {Function} onProgress - Progress callback (current, total)
   */
  const bulkImport = useCallback(async (items, createFn, onProgress = null) => {
    const results = {
      success: 0,
      failed: 0,
      errors: [],
    };

    for (let i = 0; i < items.length; i++) {
      try {
        await createFn(items[i]);
        results.success++;

        if (onProgress) {
          onProgress(i + 1, items.length);
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          item: items[i],
          error: error.message,
        });
      }
    }

    return results;
  }, []);

  /**
   * Download file with custom content and type
   * @param {string} content - File content
   * @param {string} filename - Filename with extension
   * @param {string} type - MIME type
   */
  // Same blob + <a download> hand-off as every other export (exportHelpers
  // downloadBlob); kept on the hook for its existing callers.
  const downloadFile = useCallback((content, filename, type = 'text/plain') => {
    try {
      downloadBlob(new Blob([content], { type }), filename);
      return true;
    } catch (error) {
      console.error('Failed to download file:', error);
      throw error;
    }
  }, []);

  /**
   * Copy data to clipboard as JSON
   * @param {*} data - Data to copy
   * @param {boolean} prettify - Format JSON with indentation
   */
  const copyToClipboard = useCallback(async (data, prettify = true) => {
    try {
      const jsonString = prettify
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data);

      await navigator.clipboard.writeText(jsonString);
      return true;
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      throw error;
    }
  }, []);

  /**
   * Export data as Base64 encoded string (copies to clipboard)
   * @param {*} data - Data to export
   * @param {boolean} prettify - Format JSON before encoding
   * @param {Function|null} onProgress - progress callback (see top of file)
   * @returns {Promise<string>} Base64 encoded string
   */
  const exportToBase64 = useCallback(async (data, prettify = false, onProgress = null) => {
    try {
      const report = makeReporter(onProgress);
      const writeLabel = 'Writing JSON';

      const total = Array.isArray(data) ? data.length : 0;
      report({ label: writeLabel, current: 0, total, indeterminate: total === 0 });
      const parts = await stringifyToParts(data, {
        indent: prettify ? 2 : 0,
        yielder: createYielder(),
        onProgress: (current, count) => report({ label: writeLabel, current, total: count }),
      });

      // btoa needs one string; the encode itself is a single native pass
      report({ label: 'Encoding Base64', indeterminate: true });
      const jsonString = parts.join('');
      const base64 = btoa(unescape(encodeURIComponent(jsonString)));

      report({ label: 'Copying to clipboard', indeterminate: true });
      await navigator.clipboard.writeText(base64);
      report({
        label: 'Copied',
        percent: 100,
        log: `Encoded ${formatBytes(jsonString.length)} of JSON as Base64 and copied it to the clipboard`,
        logType: 'success',
      });
      return base64;
    } catch (error) {
      console.error('Failed to export to Base64:', error);
      throw error;
    }
  }, []);

  /**
   * Import data from Base64 encoded string
   * @param {string} base64String - Base64 encoded JSON string
   * @returns {*} Parsed data
   */
  const importFromBase64 = useCallback((base64String) => {
    try {
      const jsonString = decodeURIComponent(escape(atob(base64String.trim())));
      return JSON.parse(jsonString);
    } catch (error) {
      console.error('Failed to import from Base64:', error);
      throw new Error('Invalid Base64 data or malformed JSON');
    }
  }, []);

  /**
   * Export all documents to ZIP with categories as directories
   * @param {Array} documents - All documents
   * @param {string} filename - Base filename for ZIP
   * @param {Function|null} onProgress - progress callback (see top of file)
   */
  const exportAllToZip = useCallback(async (documents, filename = 'documents', onProgress = null) => {
    try {
      const report = makeReporter(onProgress);
      const maybeYield = createYielder();
      const STEPS = 4;
      const zip = new JSZip();

      // Fetch fresh document content from database
      const { db } = await import('../db/database');
      const loadLabel = 'Loading documents';
      report({ step: 1, steps: STEPS, label: loadLabel, current: 0, total: documents.length });
      const freshDocuments = await fetchFreshDocuments(db, documents, (current, total) =>
        report({ step: 1, steps: STEPS, label: loadLabel, current, total })
      );

      // Group documents by category
      const categorized = {};
      freshDocuments.forEach(doc => {
        const category = doc.category || 'General';
        if (!categorized[category]) {
          categorized[category] = [];
        }
        categorized[category].push(doc);
      });

      // Load media once and index by filename for per-category lookups
      report({ step: 2, steps: STEPS, label: 'Loading media library', indeterminate: true });
      const media = await db.media.toArray();
      const mediaByFilename = new Map(media.map(item => [item.filename, item]));
      report({ log: `Loaded ${freshDocuments.length} documents in ${Object.keys(categorized).length} categories, ${media.length} media files` });

      // Add documents to ZIP with category folders
      const addLabel = 'Adding documents';
      let added = 0;
      report({ step: 3, steps: STEPS, label: addLabel, current: 0, total: freshDocuments.length });
      for (const categoryName of Object.keys(categorized)) {
        const categoryDocs = categorized[categoryName];

        // Sanitize category name for directory
        const categoryFolder = zip.folder(sanitizeZipEntryName(categoryName));

        // Distinct images referenced by this category's documents
        // (sanitized filename -> blob)
        const usedImages = new Map();

        for (const doc of categoryDocs) {
          // Sanitize title and create filename: "Title - ID.md"
          const entryName = `${sanitizeZipEntryName(`${doc.title || 'Untitled'} - ${doc.id}`)}.md`;

          // Convert attachment: URLs to images/ paths for external editors,
          // collecting the referenced media blobs for this category
          const content = rewriteAttachmentLinks(doc.content || '', mediaByFilename, usedImages);

          // Add document content
          categoryFolder.file(entryName, content);
          added += 1;
          report({ step: 3, steps: STEPS, label: addLabel, current: added, total: freshDocuments.length });
          await maybeYield();
        }

        // Write only this category's referenced images into its own images/ folder
        addImagesFolder(categoryFolder, usedImages);
      }

      // Generate and download ZIP
      const blob = await generateZipBlob(zip, report, 4, STEPS);
      const downloadName = `${filename}-${dateStamp()}.zip`;
      downloadBlob(blob, downloadName);
      report({
        step: 4,
        steps: STEPS,
        label: 'Saved',
        percent: 100,
        log: `Saved ${downloadName} (${formatBytes(blob.size)})`,
        logType: 'success',
      });

      return true;
    } catch (error) {
      console.error('Failed to export to ZIP:', error);
      throw error;
    }
  }, []);

  /**
   * Export category to ZIP with documents as markdown files
   * @param {Array} items - All items
   * @param {string} categoryName - Category to export
   * @param {string} filename - Base filename
   * @param {Function|null} onProgress - progress callback (see top of file)
   */
  const exportCategoryToZip = useCallback(async (items, categoryName, filename, onProgress = null) => {
    try {
      const report = makeReporter(onProgress);
      const maybeYield = createYielder();
      const STEPS = 4;
      const categoryItems = items.filter(item => (item.category || 'General') === categoryName);

      // Fetch fresh document content from database
      const { db } = await import('../db/database');
      const loadLabel = 'Loading documents';
      report({ step: 1, steps: STEPS, label: loadLabel, current: 0, total: categoryItems.length });
      const freshCategoryItems = await fetchFreshDocuments(db, categoryItems, (current, total) =>
        report({ step: 1, steps: STEPS, label: loadLabel, current, total })
      );

      const zip = new JSZip();

      // Sanitize category name (kept for the outer ZIP filename below)
      const sanitizedCategory = categoryName.replace(/[<>:"/\\|?*]/g, '-');
      const categoryFolder = zip.folder(sanitizeZipEntryName(categoryName));

      // Load media once and index by filename for lookups
      report({ step: 2, steps: STEPS, label: 'Loading media library', indeterminate: true });
      const media = await db.media.toArray();
      const mediaByFilename = new Map(media.map(item => [item.filename, item]));
      report({ log: `Loaded ${freshCategoryItems.length} documents from "${categoryName}", ${media.length} media files` });

      // Distinct images referenced by this category's documents
      // (sanitized filename -> blob)
      const usedImages = new Map();

      const addLabel = 'Adding documents';
      report({ step: 3, steps: STEPS, label: addLabel, current: 0, total: freshCategoryItems.length });
      for (let i = 0; i < freshCategoryItems.length; i++) {
        const doc = freshCategoryItems[i];
        // Sanitize title and create filename: "Title - ID.md"
        const fileName = `${sanitizeZipEntryName(`${doc.title || 'Untitled'} - ${doc.id}`)}.md`;

        // Convert attachment: URLs to images/ paths for external editors,
        // collecting the referenced media blobs for this category
        const content = rewriteAttachmentLinks(doc.content || '', mediaByFilename, usedImages);

        // Add document content
        categoryFolder.file(fileName, content);
        report({ step: 3, steps: STEPS, label: addLabel, current: i + 1, total: freshCategoryItems.length });
        await maybeYield();
      }

      // Write only this category's referenced images into its own images/ folder
      addImagesFolder(categoryFolder, usedImages);

      // Generate and download ZIP
      const blob = await generateZipBlob(zip, report, 4, STEPS);
      const sanitizedFilename = filename.toLowerCase().replace(/\s+/g, '-');
      const downloadName = `${sanitizedFilename}-${sanitizedCategory}-${dateStamp()}.zip`;
      downloadBlob(blob, downloadName);
      report({
        step: 4,
        steps: STEPS,
        label: 'Saved',
        percent: 100,
        log: `Saved ${downloadName} (${formatBytes(blob.size)})`,
        logType: 'success',
      });

      return true;
    } catch (error) {
      console.error('Failed to export category to ZIP:', error);
      throw error;
    }
  }, []);

  /**
   * Export a single document as ZIP (markdown file + referenced images at the ZIP root)
   * @param {object} doc - Document to export
   * @param {Function|null} onProgress - progress callback (see top of file)
   */
  const exportDocumentToZip = useCallback(async (doc, onProgress = null) => {
    try {
      const report = makeReporter(onProgress);
      const STEPS = 3;

      // Fetch fresh document content from database
      report({ step: 1, steps: STEPS, label: 'Loading document', indeterminate: true });
      const { db } = await import('../db/database');
      const freshDoc = (await db.documents.get(doc.id)) || doc;

      const zip = new JSZip();

      // Load media once and index by filename for lookups
      report({ step: 2, steps: STEPS, label: 'Loading media library', indeterminate: true });
      const media = await db.media.toArray();
      const mediaByFilename = new Map(media.map(item => [item.filename, item]));

      // Distinct images referenced by this document
      // (sanitized filename -> blob)
      const usedImages = new Map();

      // Sanitize title and create filename: "Title - ID.md"
      const fileName = `${sanitizeZipEntryName(`${freshDoc.title || 'Untitled'} - ${freshDoc.id}`)}.md`;

      // Convert attachment: URLs to images/ paths for external editors,
      // collecting the referenced media blobs for this document
      const content = rewriteAttachmentLinks(freshDoc.content || '', mediaByFilename, usedImages);

      // Add document content at the ZIP root
      zip.file(fileName, content);

      // Write only this document's referenced images into a root images/ folder
      addImagesFolder(zip, usedImages);
      report({ log: `Added ${fileName} and ${usedImages.size} referenced image${usedImages.size === 1 ? '' : 's'}` });

      // Generate and download ZIP
      const blob = await generateZipBlob(zip, report, 3, STEPS);
      const downloadName = `${sanitizeZipEntryName(freshDoc.title || 'Untitled')}-${dateStamp()}.zip`;
      downloadBlob(blob, downloadName);
      report({
        step: 3,
        steps: STEPS,
        label: 'Saved',
        percent: 100,
        log: `Saved ${downloadName} (${formatBytes(blob.size)})`,
        logType: 'success',
      });

      return true;
    } catch (error) {
      console.error('Failed to export document to ZIP:', error);
      throw error;
    }
  }, []);

  /**
   * Export one document as PDF, as the preview renders it (same markdown
   * pipeline, attachment images resolved inline).
   *
   * @param {object} doc - Document to export
   * @param {Function|null} onProgress - progress callback (see top of file);
   *   the print pass itself is shown as indeterminate, the surrounding
   *   phases (image re-encoding, band stamping) report what they can.
   * @param {{ signal?: AbortSignal, pageSize?: 'A4'|'Letter'|'Legal', landscape?: boolean }} [options]
   *   page size / orientation (default A4 portrait; see PdfExportOptionsModal)
   *
   * The document is printed by Chromium's own engine in the Electron main
   * process (src/utils/pdfExportNative.js + electron/pdf-export.cjs):
   * vector text in the preview's fonts, inline-SVG diagrams, native page
   * breaks, link annotations and a document outline; `options.signal`
   * cancels it. Desktop app only: in a plain browser (the dev server) the
   * export is unavailable and this rejects with a clear message.
   */
  const exportDocumentToPDF = useCallback(async (doc, onProgress = null, { signal = null, pageSize, landscape } = {}) => {
    try {
      const report = makeReporter(onProgress);
      const STEPS = 5;

      // Fetch fresh document content from database
      report({ step: 1, steps: STEPS, label: 'Loading document', indeterminate: true });
      const { db } = await import('../db/database');
      const freshDoc = (await db.documents.get(doc.id)) || doc;

      if (isNativePdfExportAvailable()) {
        const filename = `${sanitizeZipEntryName(freshDoc.title || 'Untitled')}-${dateStamp()}.pdf`;
        return await exportDocumentToPDFNative(freshDoc, { report, filename, signal, pageSize, landscape });
      }

      // Plain browser (dev server, tests): there is no print engine to hand
      // the document to. The sidebar disables the menu item in that case;
      // this is the belt-and-braces message if it is called anyway.
      throw new Error(desktopOnly('PDF export'));
    } catch (error) {
      console.error('Failed to export document to PDF:', error);
      throw error;
    }
  }, []);

  return {
    exportToJSON,
    importFromJSON,
    loadDocumentsWithContent,
    exportCategory,
    bulkImport,
    downloadFile,
    copyToClipboard,
    exportAllToZip,
    exportCategoryToZip,
    exportDocumentToZip,
    exportDocumentToPDF,
    exportToBase64,
    importFromBase64,
  };
}

/**
 * Validation helpers for common data structures
 */
export const validators = {
  /**
   * Validate array of items
   */
  isArray: (data) => Array.isArray(data),

  /**
   * Validate array with required fields
   */
  hasRequiredFields: (fields) => (data) => {
    if (!Array.isArray(data)) return false;
    return data.every(item =>
      fields.every(field => Object.prototype.hasOwnProperty.call(item, field))
    );
  },

  /**
   * Validate template structure
   */
  isTemplateArray: (data) => {
    return Array.isArray(data) && data.every(item =>
      Object.prototype.hasOwnProperty.call(item, 'name') &&
      Object.prototype.hasOwnProperty.call(item, 'jql')
    );
  },

  /**
   * Validate document structure
   */
  isDocumentArray: (data) => {
    return Array.isArray(data) && data.every(item =>
      Object.prototype.hasOwnProperty.call(item, 'title') &&
      Object.prototype.hasOwnProperty.call(item, 'content')
    );
  },

  /**
   * Validate engine template structure
   */
  isEngineTemplateArray: (data) => {
    return Array.isArray(data) && data.every(item =>
      Object.prototype.hasOwnProperty.call(item, 'name') &&
      Object.prototype.hasOwnProperty.call(item, 'urlTemplate')
    );
  },
};
