/**
 * Documents "Import from JSON" (sidebar hamburger menu -> ImportFlow:
 * ImportInputModal -> ImportModal). One place for what the feature accepts
 * and how an imported record becomes a document row, shared by the sidebar
 * (validation before anything is written) and DocumentsPage (the per-item
 * import), so both stay in step and can be tested without mounting the page.
 *
 * Accepted input: a JSON ARRAY of document objects, each with at least a
 * `title` or a `content` string:
 *   [{ "title": "...", "content": "...", "category": "...", "locked": false }]
 * That is exactly what the Documents exports write (Export All / Export
 * Category / single document -> JSON, Export as Base64), which carry the
 * full DB records (id, stableId, updatedAt, cloud fields, ...); every field
 * other than title/content/category/locked (and the optional `media` list
 * of embedded images every JSON/Base64 export writes - see documentAttachments.js)
 * is ignored on import and the document is created as a NEW local document
 * (fresh id/stableId/updatedAt, not in the cloud). Nothing is de-duplicated:
 * importing the same file twice creates the documents twice (images are
 * de-duplicated by filename + bytes, see documentAttachments.js).
 *
 * NOT accepted (with a pointed error instead of a generic one): a single
 * document object (wrap it in [ ]), and a whole database backup from Export
 * Database (an object with `version` + `documents` + ... - that belongs to
 * Import Database in the app menu, or paste just its "documents" array).
 *
 * This is deliberately separate from src/utils/importDatabase.js (the
 * database backup importer with merge/replace/dry-run); the two share only
 * createDocument().
 */

import { db } from '../db/database';
import { createDocument, getCategories, getDocumentsMetadata } from './documents';
import { importDocumentMedia, newImportSession } from './documentAttachments';
import { generateStableId } from './stableId';

const DEFAULT_CATEGORY = 'General';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A field counts as "given" when it is a non-empty string; null/undefined
// are "not given"; anything else (number, object, array, boolean) is a
// shape error that is reported instead of being stringified into a title.
const isGiven = (v) => typeof v === 'string' && v.length > 0;
const isAbsent = (v) => v === undefined || v === null;

function positions(indexes) {
  return indexes.map((i) => i + 1).join(', ');
}

// Per-item problems, shared by the whole-file validation (which rejects
// the file) and the runner (which reports them as invalid rows).
const NOT_OBJECT = 'not a document object';
const WRONG_TYPES = 'title or content is not text';
const MISSING_BOTH = 'missing both title and content';
const BAD_MEDIA = 'its "media" field is not a list of images';

export function itemProblem(doc) {
  if (!isPlainObject(doc)) return NOT_OBJECT;
  const titleOk = isGiven(doc.title) || isAbsent(doc.title) || doc.title === '';
  const contentOk = isGiven(doc.content) || isAbsent(doc.content) || doc.content === '';
  if (!titleOk || !contentOk) return WRONG_TYPES;
  if (!isGiven(doc.title) && !isGiven(doc.content)) return MISSING_BOTH;
  // Optional embedded images: absent in older files, which is fine;
  // present but not a list is a broken file.
  if (!isAbsent(doc.media) && !Array.isArray(doc.media)) return BAD_MEDIA;
  return null;
}

/** Does this look like an Export Database backup file? */
export function looksLikeDatabaseBackup(data) {
  return isPlainObject(data) && Array.isArray(data.documents)
    && (data.version !== undefined || data.formatVersion !== undefined || Array.isArray(data.documentTemplates));
}

/**
 * Validate parsed JSON for the Documents import (ImportInputModal's
 * validateFn contract: `true` when importable, else an error string).
 * Nothing is written here; the ImportModal only starts when this is true,
 * so a malformed file never leaves a partial import behind.
 * @param {*} data - result of JSON.parse
 * @returns {true|string}
 */
export function validateDocumentsImport(data) {
  if (!Array.isArray(data)) {
    if (looksLikeDatabaseBackup(data)) {
      return 'This file is a database backup (Export Database), not a list of documents. '
        + 'Use Import Database from the app menu to restore it, or paste just its "documents" array here.';
    }
    if (isPlainObject(data) && (isGiven(data.title) || isGiven(data.content))) {
      return 'Invalid format: Expected an array of documents. This is a single document - wrap it in [ ... ] to import it.';
    }
    return 'Invalid format: Expected an array of documents';
  }
  if (data.length === 0) {
    return 'Array is empty: No documents to import';
  }

  const notObjects = [];
  const missingBoth = [];
  const wrongTypes = [];
  const badMedia = [];
  data.forEach((doc, index) => {
    switch (itemProblem(doc)) {
      case NOT_OBJECT: notObjects.push(index); break;
      case WRONG_TYPES: wrongTypes.push(index); break;
      case MISSING_BOTH: missingBoth.push(index); break;
      case BAD_MEDIA: badMedia.push(index); break;
      default: break;
    }
  });

  if (notObjects.length > 0) {
    return `Invalid document structure: Items at positions ${positions(notObjects)} are not document objects`;
  }
  if (wrongTypes.length > 0) {
    return `Invalid document structure: Documents at positions ${positions(wrongTypes)} have a title or content that is not text`;
  }
  if (missingBoth.length > 0) {
    return `Invalid document structure: Documents at positions ${positions(missingBoth)} are missing both title and content`;
  }
  if (badMedia.length > 0) {
    return `Invalid document structure: Documents at positions ${positions(badMedia)} have a "media" field that is not a list of images`;
  }
  return true;
}

/**
 * Map one imported record onto the fields a new document is created with.
 * Only title/content/category/locked are taken; a missing or non-text
 * category falls back to "General" (a non-string category would never show
 * up in the sidebar, which lists categories from the string keys of the
 * `category` index), and `locked` is coerced to a boolean.
 * @param {object} documentData
 * @returns {{ title: string, content: string, category: string, locked: boolean }}
 */
export function toImportedDocument(documentData) {
  const data = isPlainObject(documentData) ? documentData : {};
  return {
    title: isGiven(data.title) ? data.title : 'Untitled Document',
    content: typeof data.content === 'string' ? data.content : '',
    category: isGiven(data.category) ? data.category : DEFAULT_CATEGORY,
    locked: data.locked === true,
  };
}

/**
 * Create one document from an imported record (ImportModal's onImport
 * contract; Import from Base64 uses it too). Embedded images (`media`, see documentAttachments.js) go into
 * the media library first - added, reused when an identical image already
 * exists, or stored under a new name (with the document's links rewritten)
 * when a different local image owns the filename. Resolves with the new
 * document id plus what happened to its images, and `logs` lines the
 * ImportModal appends to its log; rejects on a DB error so the ImportModal
 * can log it against that document and carry on.
 * @param {object} documentData
 * @returns {Promise<{ id: number, images: { imported: string[], reused: string[], renamed: Array<[string, string]>, skipped: Array<{ filename: string, reason: string }> }, logs: Array<{ message: string, type: string }> }>}
 */
export async function importDocumentFromJson(documentData, session = newImportSession(), { preserveStableId = false } = {}) {
  const mapped = toImportedDocument(documentData);
  // Merge mode keeps the file's stableId on a newly created document so a
  // later re-import of the same file recognizes it (the database import
  // does the same); otherwise a copy is a new document with a fresh id.
  if (preserveStableId && typeof documentData?.stableId === 'string' && documentData.stableId !== '') {
    mapped.stableId = documentData.stableId;
  }
  const logs = [];
  let images = { imported: [], reused: [], renamed: [], skipped: [] };
  if (Array.isArray(documentData?.media) && documentData.media.length > 0) {
    const { content, ...rest } = await importDocumentMedia({ ...documentData, content: mapped.content }, session);
    images = rest;
    mapped.content = content;
    const parts = [];
    if (images.imported.length) parts.push(`${images.imported.length} added`);
    if (images.reused.length) parts.push(`${images.reused.length} already in the library`);
    if (images.renamed.length) parts.push(`${images.renamed.length} renamed`);
    const total = images.imported.length + images.reused.length + images.renamed.length;
    if (total > 0) {
      logs.push({ message: `  ${total} image${total !== 1 ? 's' : ''} (${parts.join(', ')})`, type: 'info' });
    }
    for (const [from, to] of images.renamed) {
      logs.push({ message: `  ⚠ A different image named "${from}" already exists here - stored as "${to}" and the links were updated`, type: 'warning' });
    }
    for (const s of images.skipped) {
      logs.push({ message: `  ⚠ Image "${s.filename}" skipped: ${s.reason}`, type: 'warning' });
    }
  }
  const id = await createDocument(mapped, { writer: session.writer });
  return { id, images, logs };
}

/**
 * Run the Documents import over a validated (or not: per-item problems
 * become invalid rows) list of items - the ONE code path for the dry run
 * and the real import, like src/utils/importDatabase.js runImport(): with
 * `dryRun` every read is real but the write sink (createWriter) stores
 * nothing, so the statistics of a dry run equal those of the real run that
 * follows it on the same file and DB state.
 *
 * `mergeMode` (the "Keep existing documents" checkbox) mirrors the database
 * import's merge: an item is matched to a local document by stableId when
 * both carry one, else by title + category (trimmed, create defaults) - but
 * never to a local document with a DIFFERENT stableId. Matched + identical
 * title/content/category -> unchanged (skipped); matched + the file's
 * updatedAt strictly newer -> replaced (title/content/category/locked; local
 * identity and cloud fields kept); otherwise only blank local fields are
 * filled in (local edits kept); a locked local document is never modified
 * (skipped, counted in `locked`). Unmatched items are created and KEEP the
 * file's stableId so a later re-import of the same file matches them. With
 * merge off every item is created as a new document with a fresh stableId.
 *
 * Progress goes to `onProgress({ current, total, log, logType })` (the
 * ImportModal's log pane). Resolves with { mode: 'documents', dryRun,
 * mergeMode, summary, totals } where summary has
 *   documents          created / updated / filled / skipped / invalid (+
 *                      errors with reasons); with merge off `sameTitle` and a
 *                      `note` count the imported documents whose title an
 *                      existing document in the same category already has
 *                      (reported, not acted on); with merge on `locked` counts
 *                      the matched-but-locked documents (in skipped)
 *   category:<name>    the same outcomes per target category, `label` marks
 *                      new ones
 *   images             created = added + renamed (note lists the renames and
 *                      the documents whose links were rewritten), skipped =
 *                      reused (already in the library), invalid = broken
 *                      media entries with reasons
 * and totals = mergeTotals(summary).
 * @param {Array} items - parsed import file
 * @param {{ dryRun?: boolean, onProgress?: Function }} [options]
 */
export async function runDocumentsImport(items, { dryRun = false, mergeMode = false, onProgress = null } = {}) {
  const { createWriter, newSummary, tally, tallyInvalid, mergeTotals, importedIsNewer, missingFieldFills, toMillis } = await import('./importDatabase');
  const report = (u) => { if (onProgress) onProgress(u); };
  const session = newImportSession(createWriter(dryRun));
  const list = Array.isArray(items) ? items : [];
  const existingCategories = new Set(await getCategories());

  const documents = { ...newSummary(), sameTitle: 0, sameTitles: [], locked: 0, lockedTitles: [] };
  const images = { ...newSummary(), renamed: [], reused: [] };
  const categories = new Map(); // name -> summary row

  // Merge mode: the local documents (metadata, content read on demand)
  // indexed like the database import does - stableId first, title+category
  // as the fallback (trimmed, with the create defaults). Rows created in
  // this run join the index so a duplicate inside the file matches it.
  const keyOf = (title, category) => JSON.stringify([String(title ?? '').trim() || 'Untitled', String(category ?? '').trim() || DEFAULT_CATEGORY]);
  const byStableId = new Map();
  const byKey = new Map();
  if (mergeMode) {
    for (const row of await getDocumentsMetadata()) {
      if (typeof row.stableId === 'string' && row.stableId && !byStableId.has(row.stableId)) byStableId.set(row.stableId, row);
      const key = keyOf(row.title, row.category);
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  const findLocal = (item, mapped) => {
    const sid = typeof item.stableId === 'string' && item.stableId !== '' ? item.stableId : null;
    if (sid && byStableId.has(sid)) return byStableId.get(sid);
    const candidate = byKey.get(keyOf(mapped.title, mapped.category));
    if (!candidate) return undefined;
    // Both carry ids and they differ: distinct documents that share a name
    if (sid && typeof candidate.stableId === 'string' && candidate.stableId !== '') return undefined;
    return candidate;
  };
  const remember = (row) => {
    if (typeof row.stableId === 'string' && row.stableId && !byStableId.has(row.stableId)) byStableId.set(row.stableId, row);
    const key = keyOf(row.title, row.category);
    if (!byKey.has(key)) byKey.set(key, row);
  };
  const categoryRow = (name) => {
    let row = categories.get(name);
    if (!row) {
      const isNew = !existingCategories.has(name);
      row = { ...newSummary(), isNew, label: `Category "${name}"${isNew ? ' (new)' : ''}` };
      categories.set(name, row);
    }
    return row;
  };
  const tallyImages = (result) => {
    for (const name of result.images.imported) tally(images, 'created', name);
    for (const [from, to] of result.images.renamed) {
      tally(images, 'created', to);
      images.renamed.push({ from, to, document: result.title });
    }
    for (const name of result.images.reused) {
      tally(images, 'skipped', name);
      images.reused.push(name);
    }
    for (const s of result.images.skipped) tallyInvalid(images, s.filename, s.reason);
    for (const line of result.logs) report({ log: line.message, logType: line.type });
  };

  report({ current: 0, total: list.length, log: `Starting ${dryRun ? 'dry run' : 'import'} of ${list.length} document(s)${mergeMode ? ' (merge into existing documents)' : ''}...` });
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const problem = itemProblem(item);
    const title = isPlainObject(item) && isGiven(item.title) ? item.title : `item ${i + 1}`;
    if (problem) {
      tallyInvalid(documents, title, problem);
      report({ current: i + 1, total: list.length, log: `✗ Skipped "${title}": ${problem}`, logType: 'error' });
      continue;
    }
    const mapped = toImportedDocument(item);
    report({ log: `${dryRun ? 'Checking' : 'Importing'} "${mapped.title}"...` });
    try {
      const local = mergeMode ? findLocal(item, mapped) : undefined;
      if (!local) {
        // Not matched (or merge off): a new document, as always
        if (!mergeMode) {
          const sameTitle = await db.documents.where('title').equals(mapped.title)
            .filter((d) => (d.category || DEFAULT_CATEGORY) === mapped.category).count();
          if (sameTitle > 0) {
            documents.sameTitle += 1;
            if (documents.sameTitles.length < 5) documents.sameTitles.push(mapped.title);
          }
        }
        const result = await importDocumentFromJson(item, session, { preserveStableId: mergeMode });
        tally(documents, 'created', mapped.title);
        tally(categoryRow(mapped.category), 'created', mapped.title);
        tallyImages({ ...result, title: mapped.title });
        if (mergeMode) remember({ id: result.id, title: mapped.title, category: mapped.category, stableId: typeof item.stableId === 'string' && item.stableId ? item.stableId : null, locked: mapped.locked, updatedAt: Date.now(), content: mapped.content });
        report({ current: i + 1, total: list.length, log: `✓ ${dryRun ? 'Would import' : 'Imported'} "${mapped.title}"`, logType: 'success' });
        continue;
      }

      // Matched an existing document (merge mode)
      const row = categoryRow(mapped.category);
      if (local.locked) {
        tally(documents, 'skipped', mapped.title);
        tally(row, 'skipped', mapped.title);
        documents.locked += 1;
        if (documents.lockedTitles.length < 5) documents.lockedTitles.push(mapped.title);
        report({ current: i + 1, total: list.length, log: `– "${mapped.title}" matches a locked document - left untouched`, logType: 'warning' });
        continue;
      }
      // Images first (they may rewrite the content's links), then compare
      const mediaResult = Array.isArray(item.media) && item.media.length > 0
        ? await importDocumentMedia({ ...item, content: mapped.content }, session)
        : { content: mapped.content, imported: [], reused: [], renamed: [], skipped: [] };
      const incoming = { title: mapped.title, content: mediaResult.content, category: mapped.category };
      const full = 'content' in local ? local : (await db.documents.get(local.id)) || local;
      // Identical = same trimmed title and category and the same content
      // (the match key is trimmed too, so surrounding whitespace in the
      // file is not a change)
      const identical = (full.title || 'Untitled').trim() === incoming.title.trim()
        && (full.content || '') === incoming.content
        && (full.category || DEFAULT_CATEGORY).trim() === incoming.category.trim();
      let outcome;
      if (identical) {
        outcome = 'skipped';
      } else if (importedIsNewer(item.updatedAt, full.updatedAt)) {
        // The file's copy is strictly newer: replace the text fields, keep
        // the local identity and cloud fields untouched
        const replaced = {
          ...full,
          ...incoming,
          locked: mapped.locked,
          updatedAt: toMillis(item.updatedAt),
          stableId: full.stableId || (typeof item.stableId === 'string' && item.stableId) || generateStableId(),
          id: local.id,
        };
        await session.writer.put(db.documents, replaced);
        outcome = 'updated';
      } else {
        // Otherwise only fill in what is blank locally (keeps local edits)
        const fills = missingFieldFills(full, incoming);
        if (Object.keys(fills).length > 0) {
          await session.writer.update(db.documents, local.id, fills);
          outcome = 'filled';
        } else {
          outcome = 'skipped';
        }
      }
      tally(documents, outcome, mapped.title);
      tally(row, outcome, mapped.title);
      tallyImages({ images: mediaResult, logs: [], title: mapped.title });
      if (outcome === 'updated' || outcome === 'filled') {
        remember({ ...full, ...incoming, id: local.id });
      }
      const verb = outcome === 'updated' ? (dryRun ? 'Would replace (file is newer)' : 'Replaced (file is newer)')
        : outcome === 'filled' ? (dryRun ? 'Would fill in empty fields of' : 'Filled in empty fields of')
        : 'Unchanged (already here)';
      report({ current: i + 1, total: list.length, log: `${outcome === 'skipped' ? '–' : '✓'} ${verb} "${mapped.title}"`, logType: outcome === 'skipped' ? 'info' : 'success' });
    } catch (error) {
      tallyInvalid(documents, mapped.title, error?.message || String(error));
      report({ current: i + 1, total: list.length, log: `✗ Failed to import "${mapped.title}": ${error?.message || error}`, logType: 'error' });
    }
  }

  const notes = [];
  if (documents.sameTitle > 0) {
    notes.push(`${documents.sameTitle} ${documents.sameTitle === 1 ? 'has' : 'have'} the same title as an existing document in the same category (imported as a separate copy): ${documents.sameTitles.join(', ')}${documents.sameTitle > documents.sameTitles.length ? ', ...' : ''}`);
  }
  if (documents.locked > 0) {
    notes.push(`${documents.locked} locked document${documents.locked === 1 ? '' : 's'} left untouched: ${documents.lockedTitles.join(', ')}${documents.locked > documents.lockedTitles.length ? ', ...' : ''}`);
  }
  if (notes.length) documents.note = notes.join('; ');
  if (images.renamed.length > 0) {
    images.note = `${images.renamed.length} renamed because a different local image owns the name: ` +
      images.renamed.map((r) => `${r.from} → ${r.to} (links updated in "${r.document}")`).join('; ');
  }
  const summary = { documents };
  for (const name of [...categories.keys()].sort((a, b) => a.localeCompare(b))) summary[`category:${name}`] = categories.get(name);
  summary.images = images;
  const totals = mergeTotals(summary);
  // Category rows repeat the documents counts: totals count documents once
  for (const row of categories.values()) {
    for (const key of ['created', 'updated', 'filled', 'skipped']) totals[key] -= row[key];
  }
  const touched = documents.created + documents.updated + documents.filled;
  report({ log: dryRun
    ? `Dry run finished - nothing was written. ${touched} document(s) would be ${mergeMode ? 'added or merged' : 'imported'}.`
    : `✓ Import completed. ${touched} document(s) ${mergeMode ? 'added or merged' : 'imported'}${totals.invalid ? `, ${totals.invalid} invalid` : ''}.`,
    logType: totals.invalid && !touched ? 'error' : totals.invalid ? 'warning' : 'success' });
  return { mode: 'documents', dryRun, mergeMode, summary, totals };
}

/**
 * Wording for the shared ImportStats block (DocumentsImportStats.jsx).
 * @param {{ kind?: string, dryRun?: boolean, summary: object, totals: object }} result
 * @returns {{ title: string, headline: string, hint: string|null }}
 */
export function describeDocumentsImport(result) {
  const isDry = result.kind === 'dry-run' || (result.kind == null && result.dryRun);
  const would = isDry ? 'would be ' : '';
  const d = result.summary?.documents || {};
  const img = result.summary?.images || {};
  const categoryRows = Object.entries(result.summary || {}).filter(([k]) => k.startsWith('category:')).map(([, s]) => s);
  const newCats = categoryRows.filter((s) => s.isNew).length;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts = result.mergeMode
    ? [
      `${plural(d.created || 0, 'document')} ${would}added, ${d.updated || 0} ${would}replaced by newer copies, ${d.filled || 0} ${would}completed (empty fields filled in), ${d.skipped || 0} unchanged` +
        ` in ${plural(categoryRows.length, 'category', 'categories')}${newCats ? ` (${plural(newCats, 'new category', 'new categories')})` : ''}`,
    ]
    : [
      `${plural(d.created || 0, 'document')} ${would}created in ${plural(categoryRows.length, 'category', 'categories')}${newCats ? ` (${plural(newCats, 'new category', 'new categories')})` : ''}`,
    ];
  if (result.mergeMode && d.locked) parts.push(`${d.locked} locked (left untouched)`);
  if (!result.mergeMode && d.sameTitle) parts.push(`${d.sameTitle} with the same title as an existing document`);
  if (img.created || img.skipped || img.invalid) {
    const bits = [`${plural(img.created || 0, 'image')} ${would}added`];
    if (img.skipped) bits.push(`${img.skipped} already in the library`);
    if ((img.renamed || []).length) bits.push(`${img.renamed.length} renamed`);
    parts.push(bits.join(', '));
  }
  if (result.totals?.invalid) parts.push(`${result.totals.invalid} invalid`);
  const modeLabel = result.mergeMode ? 'merge into existing documents' : 'add as new documents';
  return {
    title: isDry ? `Dry run (${modeLabel}) - nothing was written` : `Import complete (${modeLabel})`,
    headline: parts.join('; '),
    hint: isDry ? 'Review the numbers below, then click Import Documents to apply exactly this plan.' : null,
  };
}
