/**
 * Full database backup export (File > Database > Export).
 *
 * Extracted from CompactSidebar.handleExportDB so it can run as a job under
 * the shared Export Progress modal. Same replacer and 2-space indentation as
 * the original; the top-level keys are stable and importDatabase.js reads
 * new and old files alike. Format version 2 (formatVersion: 2) carries
 * TaskWarrior tasks per instance as TaskWarrior JSON (taskwarriorTasks,
 * taskTombstones, taskwarriorReports - see taskwarriorBackup.js) instead of
 * the former flat `tasks` array of app rows.
 *
 * What changed is HOW it is produced. The old implementation converted
 * every media blob to base64 in one Promise.all and then ran a single
 * synchronous JSON.stringify over the whole object; on a large library the
 * renderer froze for the entire export with no feedback. This version:
 *
 *   1. reads every table (in parallel, as before) but reports each table as
 *      it lands,
 *   2. converts media blobs one at a time, yielding to the event loop on a
 *      time budget so the progress bar repaints,
 *   3. serializes incrementally (see incrementalJson.js): per top-level
 *      section, and per element inside the big arrays, again yielding as
 *      it goes - so the "un-chunkable" JSON.stringify step is chunked after
 *      all, and the result is a list of fragments handed to Blob without a
 *      single giant intermediate string,
 *   4. triggers the download.
 *
 * @param {Function|null} onProgress - progress callback; receives updates
 *   shaped like ExportProgressModal expects:
 *   { step, steps, label, current, total, indeterminate, log, logType }
 * @returns {Promise<{ filename: string, size: number }>}
 */
import { stringifyToParts } from './incrementalJson';
import { createYielder } from './yieldToUI';
import { formatBytes, downloadBlob, dateStamp } from './exportHelpers';

const STEPS = 4;

// localStorage keys included in the backup (UI state worth restoring)
const LOCAL_STORAGE_KEYS = [
  'innerSidebarVisible',
  'aiChatSettings',
  'expandedDocumentCategories',
  'expandedTemplateCategories',
  'expandedJQLCategories',
  'expandedEngineCategories',
  'expandedWorkflowCategories',
  'expandedKanbanCategories',
  'expandedTaskInstanceCategories',
  'expandedReportCategories',
  'documentPreviewModes',
  'kanbanSortBy',
  'openKanbanTabs',
  // currentTaskInstanceId / taskInstanceOpenTabs are deliberately NOT
  // exported: they hold numeric instance ids that mean nothing on another
  // machine (and change even here after a replace import).
  'taskInnerSidebarVisible',
  'taskReportsSidebarCollapsed',
  'taskInstancesSortBy',
  'taskExpandedSections',
];

// Human-readable labels for the serialization phase, keyed by export section
const SECTION_LABELS = {
  documents: 'documents',
  documentCategories: 'document categories',
  documentTemplates: 'document templates',
  jqlTemplates: 'JQL templates',
  engineTemplates: 'engine templates',
  workflows: 'workflows',
  kanbanBoards: 'kanban boards',
  kanbanCards: 'kanban cards',
  taskwarriorInstances: 'TaskWarrior instances',
  taskwarriorTasks: 'TaskWarrior tasks',
  taskwarriorTasksSource: 'TaskWarrior task sources',
  taskTombstones: 'deleted-task tombstones',
  taskwarriorReports: 'TaskWarrior reports',
  customReports: 'custom reports',
  calendarEventTemplates: 'calendar event templates',
  sshCommands: 'SSH commands',
  customGrids: 'custom grids',
  customQuizzes: 'custom quizzes',
  openshiftTemplates: 'OpenShift templates',
  gtfobinsFunctions: 'gtfobins functions',
  gtfobinsExecutables: 'gtfobins executables',
  gtfobinsContexts: 'gtfobins contexts',
  media: 'media files',
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Replacer shared by every section: Dates as ISO strings, drop functions
// and DOM nodes (defensive - nothing in the DB should hold either)
function exportReplacer(key, value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'function' || (typeof Node !== 'undefined' && value instanceof Node)) {
    return undefined;
  }
  return value;
}

export async function exportDatabase(onProgress = null) {
  const report = (update) => {
    if (onProgress) onProgress(update);
  };
  const maybeYield = createYielder();

  const exportData = await collectExportData(report, { maybeYield });

  // ---- Step 3: serialize incrementally -----------------------------------
  report({ step: 3, steps: STEPS, label: 'Writing JSON', indeterminate: true });
  const parts = await stringifyToParts(exportData, {
    replacer: exportReplacer,
    indent: 2,
    yielder: maybeYield,
    onProgress: (current, total, key) => {
      report({
        step: 3,
        steps: STEPS,
        label: `Writing ${SECTION_LABELS[key] || key}`,
        current,
        total,
      });
    },
  });

  // ---- Step 4: download --------------------------------------------------
  report({ step: 4, steps: STEPS, label: 'Saving file', indeterminate: true });
  const dataBlob = new Blob(parts, { type: 'application/json' });
  const filename = `jacarium-db-${dateStamp()}.json`;
  downloadBlob(dataBlob, filename);

  report({
    step: 4,
    steps: STEPS,
    label: 'Saved',
    percent: 100,
    log: `Saved ${filename} (${formatBytes(dataBlob.size)})`,
    logType: 'success',
  });

  return { filename, size: dataBlob.size };
}

/**
 * Steps 1-2 of the export: read every table, convert media, collect the
 * TaskWarrior section (see taskwarriorBackup.js) and assemble the export
 * object - the exact value exportDatabase() serializes. Exported so tests
 * can check the file's shape without a download.
 *
 * @param {Function} report - progress callback (see exportDatabase)
 * @param {{ maybeYield?: Function, fetchTasks?: Function }} [options]
 *   fetchTasks: test seam for the per-instance CLI export
 * @returns {Promise<Object>} the export object
 */
export async function collectExportData(report = () => {}, { maybeYield = createYielder(), fetchTasks } = {}) {

  const [
    { getDocuments },
    { getDocumentTemplates },
    { getTemplates },
    { getEngineTemplates },
    { getWorkflows },
    { getBoards, getCards },
    { getTasks },
    { getAllInstances },
    { collectTaskwarriorBackup, BACKUP_FORMAT_VERSION },
    { getCustomReports },
    { getDocumentCategories },
    { getSSHCommands },
    { db },
    { getAllCustomGrids, getAllCustomQuizzes },
    { getOpenshiftTemplates },
    { getGtfobinsFunctions, getGtfobinsExecutables, getGtfobinsContexts },
  ] = await Promise.all([
    import('./documents'),
    import('./documentTemplates'),
    import('../templates/jqlTemplates'),
    import('./engineTemplates'),
    import('./workflows'),
    import('./kanban'),
    import('./tasks'),
    import('./taskwarriorInstances'),
    import('./taskwarriorBackup'),
    import('./customReports'),
    import('./documentCategories'),
    import('./sshCommands'),
    import('../db/database'),
    import('./customContentDB'),
    import('./openshiftTemplates'),
    import('./gtfobins'),
  ]);

  // ---- Step 1: read every table ------------------------------------------
  const readers = [
    ['documents', getDocuments],
    ['document templates', getDocumentTemplates],
    ['JQL templates', getTemplates],
    ['engine templates', getEngineTemplates],
    ['workflows', getWorkflows],
    ['kanban boards', getBoards],
    ['tasks', getTasks],
    ['TaskWarrior instances', getAllInstances],
    ['TaskWarrior reports', () => db.taskwarriorReports.toArray()],
    ['custom reports', getCustomReports],
    ['document categories', getDocumentCategories],
    ['calendar event templates', () => db.calendarEventTemplates.toArray()],
    ['SSH commands', getSSHCommands],
    ['custom grids', getAllCustomGrids],
    ['custom quizzes', getAllCustomQuizzes],
    ['OpenShift templates', getOpenshiftTemplates],
    ['gtfobins functions', getGtfobinsFunctions],
    ['gtfobins executables', getGtfobinsExecutables],
    ['gtfobins contexts', getGtfobinsContexts],
    ['media records', () => db.media.toArray()],
  ];
  const readLabel = 'Reading database tables';
  report({ step: 1, steps: STEPS, label: readLabel, current: 0, total: readers.length });

  // Reads stay parallel (they were before); each one reports as it lands
  let tablesRead = 0;
  const [
    documents,
    documentTemplates,
    jqlTemplates,
    engineTemplates,
    workflows,
    kanbanBoards,
    tasks,
    taskwarriorInstances,
    taskwarriorReportRows,
    customReports,
    documentCategories,
    calendarEventTemplates,
    sshCommands,
    customGrids,
    customQuizzes,
    openshiftTemplates,
    gtfobinsFunctions,
    gtfobinsExecutables,
    gtfobinsContexts,
    mediaRecords,
  ] = await Promise.all(
    readers.map(async ([name, read]) => {
      const rows = await read();
      tablesRead += 1;
      report({
        step: 1,
        steps: STEPS,
        label: readLabel,
        current: tablesRead,
        total: readers.length,
        log: `Read ${rows.length} ${name}`,
      });
      return rows;
    })
  );

  // Kanban cards are per board
  const kanbanCards = [];
  if (kanbanBoards.length > 0) {
    const cardsLabel = 'Reading kanban cards';
    for (let i = 0; i < kanbanBoards.length; i++) {
      const boardCards = await getCards(kanbanBoards[i].id);
      kanbanCards.push(...boardCards);
      report({ step: 1, steps: STEPS, label: cardsLabel, current: i + 1, total: kanbanBoards.length });
    }
    report({ log: `Read ${kanbanCards.length} kanban cards across ${kanbanBoards.length} boards` });
  }

  // TaskWarrior tasks: `task export` per instance through the backend when it
  // answers, otherwise the cached rows (see taskwarriorBackup.js).
  report({ step: 1, steps: STEPS, label: 'Reading TaskWarrior tasks', indeterminate: true });
  const { taskwarriorTasks, taskwarriorTasksSource, taskTombstones, taskwarriorReports } =
    await collectTaskwarriorBackup({
      instances: taskwarriorInstances,
      tasks,
      reports: taskwarriorReportRows,
      report,
      ...(fetchTasks ? { fetchTasks } : {}),
    });

  // ---- Step 2: media blobs -> base64 -------------------------------------
  const media = [];
  const mediaLabel = 'Converting media files';
  report({ step: 2, steps: STEPS, label: mediaLabel, current: 0, total: mediaRecords.length });
  let mediaBytes = 0;
  for (let i = 0; i < mediaRecords.length; i++) {
    const record = mediaRecords[i];
    media.push({
      filename: record.filename,
      data: await blobToBase64(record.blob),
      mimeType: record.mimeType,
      size: record.size,
      uploadedAt: record.uploadedAt,
    });
    mediaBytes += record.size || 0;
    report({ step: 2, steps: STEPS, label: mediaLabel, current: i + 1, total: mediaRecords.length });
    await maybeYield();
  }
  if (mediaRecords.length > 0) {
    report({ log: `Encoded ${mediaRecords.length} media files (${formatBytes(mediaBytes)} raw)` });
  }

  // Sanitize documents - remove any non-serializable properties
  const cleanDocuments = documents.map((doc) => {
    const { ...cleanDoc } = doc;
    Object.keys(cleanDoc).forEach((key) => {
      if (typeof cleanDoc[key] === 'function' || (typeof Node !== 'undefined' && cleanDoc[key] instanceof Node)) {
        delete cleanDoc[key];
      }
    });
    return cleanDoc;
  });

  const localStorageData = {};
  LOCAL_STORAGE_KEYS.forEach((key) => {
    const value = localStorage.getItem(key);
    if (value !== null) {
      try {
        localStorageData[key] = JSON.parse(value);
      } catch {
        localStorageData[key] = value;
      }
    }
  });

  // Key order here IS the file's key order - keep it stable.
  // formatVersion 2: tasks travel as TaskWarrior JSON per instance
  // (taskwarriorTasks) instead of a flat `tasks` array of app rows; the
  // importer reads both (see importDatabase.js / taskwarriorBackup.js).
  const exportData = {
    version: '1.0',
    formatVersion: BACKUP_FORMAT_VERSION,
    exportDate: new Date().toISOString(),
    documents: cleanDocuments,
    documentCategories,
    documentTemplates,
    jqlTemplates,
    engineTemplates,
    workflows,
    kanbanBoards,
    kanbanCards,
    taskwarriorInstances,
    taskwarriorTasks,
    taskwarriorTasksSource,
    taskTombstones,
    taskwarriorReports,
    customReports,
    calendarEventTemplates,
    sshCommands,
    customGrids,
    customQuizzes,
    openshiftTemplates,
    gtfobinsFunctions,
    gtfobinsExecutables,
    gtfobinsContexts,
    media,
    localStorage: localStorageData,
  };

  return exportData;
}
