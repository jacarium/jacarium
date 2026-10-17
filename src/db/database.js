/**
 * Database setup using Dexie.js (IndexedDB wrapper)
 *
 * Installation required:
 * npm install dexie
 */

import Dexie from 'dexie';
import { generateStableId } from '../utils/stableId';
import { installSyncTracker } from '../sync/tracker';

// Create database instance. One database per account when the app runs
// against a server with sign-in: src/main.jsx sets the name
// (Jacarium-<user id>) before this module loads; the desktop app and
// a server without accounts keep the one 'Jacarium' database.
export const DATABASE_NAME = (typeof globalThis !== 'undefined' && globalThis.__JACARIUM_DB_NAME) || 'Jacarium';
export const db = new Dexie(DATABASE_NAME);

// Define database schema
db.version(1).stores({
  // Templates storage
  templates: '++id, name, category, createdAt, updatedAt',

  // Custom fields storage
  customFields: '&id, name, createdAt',

  // Cached JIRA data
  cache: '&key, timestamp',

  // Invalid projects tracking
  invalidProjects: '&name, timestamp',

  // Documents storage
  documents: '++id, title, category, updatedAt',
});

// Version 2: Add locked field to documents
db.version(2).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked',
});

// Version 3: Add readOnly field to documents
db.version(3).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, readOnly',
});

// Version 4: Add document templates
db.version(4).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, readOnly',
  documentTemplates: '++id, name, *tags, category, updatedAt',
});

// Version 5: Add description field to document templates
db.version(5).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, readOnly',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
});

// Version 6: Remove readOnly field from documents
db.version(6).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
});

// Version 7: Add engine templates to main database
db.version(7).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
});

// Version 8: Add cloud fields to documents for P2P sharing
db.version(8).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
});

// Version 9: workflows and environment variables move into this database
db.version(9).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId',
  envVariables: '&key, value',
});

// Version 10: Add kanban boards and cards
db.version(10).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
});

// Version 11: Add permissions field to documents for machine-level access control
db.version(11).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
});

// Version 12: Add permissions field to workflows and kanban boards
db.version(12).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
});

// Version 13: Add tasks table for TaskWarrior integration
db.version(13).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, uuid, description, status, *tags, project, priority, modified, inCloud, ownerId',
});

// Version 14: Add TaskWarrior instances and reports, update tasks with instanceId
db.version(14).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, inCloud, ownerId',
  taskwarriorInstances: '++id, name, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
});

// Version 15: Add category to taskwarriorInstances
db.version(15).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
});

// Version 16: Add time tracking and advanced TaskWarrior fields to tasks
db.version(16).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
});

// Version 17: Add custom reports for TaskWarrior (user-created report views)
db.version(17).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
});

// Version 18: Add documentCategories table for standalone category management
db.version(18).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
});

// Version 19: Add Google Calendar tables
db.version(19).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
});

// Version 20: Add SSH custom commands
db.version(20).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, name, command, description, createdAt, updatedAt',
});

// Version 21: Add OpenShift templates table
db.version(21).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, name, command, description, createdAt, updatedAt',
  openshiftTemplates: '++id, name, category, yaml, icon, description, createdAt, updatedAt',
});

// Version 22: Add media storage for document images
db.version(22).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, name, command, description, createdAt, updatedAt',
  openshiftTemplates: '++id, name, category, yaml, icon, description, createdAt, updatedAt',
  media: '++id, filename, uploadedAt',
});

// Version 23: Add stableId to documents - a UUID minted once at creation
// that identifies the same document across machines and export files (the
// Dexie `id` is per-machine; title+category breaks on rename/move). The
// upgrade backfills every existing document so old documents can participate
// in stable-identity merge matching too. Runs inside the version-change
// transaction: if it fails, the whole upgrade aborts and the DB stays at
// version 22 (no partially-migrated state).
db.version(23).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, stableId, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, name, command, description, createdAt, updatedAt',
  openshiftTemplates: '++id, name, category, yaml, icon, description, createdAt, updatedAt',
  media: '++id, filename, uploadedAt',
}).upgrade((tx) =>
  tx.table('documents').toCollection().modify((doc) => {
    if (typeof doc.stableId !== 'string' || doc.stableId === '') {
      doc.stableId = generateStableId();
    }
  })
);

// Version 24: Add tags to media (multiEntry index) so library images can be
// organized and filtered. The upgrade backfills an empty tags array on every
// existing media record so all records share the same shape and participate
// in the index. Runs inside the version-change transaction: if it fails, the
// whole upgrade aborts and the DB stays at version 23.
db.version(24).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, stableId, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, name, command, description, createdAt, updatedAt',
  openshiftTemplates: '++id, name, category, yaml, icon, description, createdAt, updatedAt',
  media: '++id, filename, uploadedAt, *tags',
}).upgrade((tx) =>
  tx.table('media').toCollection().modify((item) => {
    if (!Array.isArray(item.tags)) {
      item.tags = [];
    }
  })
);

// Version 25: Add GTFOBins tables for the Security > GTFOBins tool.
//   - gtfobinsFunctions: the capability types (shell, file-read, ...). `funcId`
//     is the stable string identifier used to reference a function from an
//     executable; it is uniquely indexed so seeding/lookups are keyed by it.
//   - gtfobinsExecutables: one row per binary. `name` is unique. `functionIds`
//     is a multiEntry index (the sorted list of function ids the executable
//     supports) so "which executables support function X" is a fast indexed
//     query. The full per-function entry data lives in the `functions` object.
// These tables have no bundled seed data: a fresh install starts empty and is
// populated by hand through the tool UI or by importing a full-database export
// that contains GTFOBins data (see src/utils/importDatabase.js).
db.version(25).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, stableId, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, name, command, description, createdAt, updatedAt',
  openshiftTemplates: '++id, name, category, yaml, icon, description, createdAt, updatedAt',
  media: '++id, filename, uploadedAt, *tags',
  gtfobinsFunctions: '++id, &funcId, label, sortOrder, isBuiltIn',
  gtfobinsExecutables: '++id, &name, *functionIds, isBuiltIn, updatedAt',
});

// Version 26: Add the GTFOBins contexts reference table. Contexts (sudo, suid,
// unprivileged, capabilities) are a closed, structural set baked into the
// code-entry schema — not user-extensible like functions. This table exists
// purely so the 4 contexts are queryable/sortable like the other tables. Like
// the other GTFOBins tables it has no bundled seed data — a fresh install
// starts empty and is populated by hand or via a full-database import. The
// actual context-usage cross-references are computed client-side from each
// executable's functions[funcId][i].contexts object, not stored relationally.
db.version(26).stores({
  templates: '++id, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, stableId, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, name, category, urlTemplate, description',
  workflows: '++id, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, name, command, description, createdAt, updatedAt',
  openshiftTemplates: '++id, name, category, yaml, icon, description, createdAt, updatedAt',
  media: '++id, filename, uploadedAt, *tags',
  gtfobinsFunctions: '++id, &funcId, label, sortOrder, isBuiltIn',
  gtfobinsExecutables: '++id, &name, *functionIds, isBuiltIn, updatedAt',
  gtfobinsContexts: '++id, &contextId, label',
});

// Version 27: synchronisation with the home server (src/sync/syncEngine.js,
// src/utils/mergeCore.js). Every synchronised table gets a syncId index - the
// identity a record keeps across devices: documents reuse their stableId
// and kanban cards their yjsId (both already minted once at creation), the
// keyed tables (customFields, envVariables, syncedCalendars) use their own
// key, everything else a syncId minted here for existing rows and by the
// engine for new ones. Three bookkeeping tables: _syncState (per record:
// the server revision it is based on, whether it has unsynced local
// changes, tombstones for deletions still to send), _syncMeta (the change
// sequence the device has seen, the device id) and _syncSnapshots (a copy
// of the database taken before the first reconciliation with a server).
// The upgrade backfills the ids inside the version transaction, like
// version 23 did for stableId.
db.version(27).stores({
  templates: '++id, syncId, name, category, createdAt, updatedAt',
  customFields: '&id, name, createdAt',
  cache: '&key, timestamp',
  invalidProjects: '&name, timestamp',
  documents: '++id, stableId, title, category, updatedAt, locked, inCloud, ownerId, permissions',
  documentTemplates: '++id, syncId, name, *tags, category, updatedAt, description',
  engineTemplates: '++id, syncId, name, category, urlTemplate, description',
  workflows: '++id, syncId, title, category, updatedAt, inCloud, ownerId, permissions',
  envVariables: '&key, value',
  kanbanBoards: '++id, syncId, title, category, createdAt, updatedAt, inCloud, ownerId, permissions',
  kanbanCards: '++id, yjsId, boardId, title, status, position, createdAt, updatedAt, priority, assignee',
  tasks: '++id, syncId, instanceId, uuid, description, status, *tags, project, priority, modified, start, end, urgency, recur, inCloud, ownerId',
  taskwarriorInstances: '++id, syncId, name, category, description, rcPath, dataPath, isActive, inCloud, ownerId, permissions, cloudDocumentId, createdAt, updatedAt',
  taskwarriorReports: '++id, syncId, instanceId, name, description, filter, columns, sort, isBuiltIn, createdAt, updatedAt',
  customReports: '++id, syncId, name, category, description, filter, createdAt, updatedAt',
  documentCategories: '++id, syncId, name, position, createdAt, updatedAt',
  syncedCalendars: '&id, summary, syncEnabled, lastSynced, syncStatus, eventCount, createdAt, updatedAt',
  calendarEvents: '&id, calendarId, eventId, startDateTime, endDateTime, lastFetched',
  calendarEventTemplates: '++id, syncId, name, *tags, defaultCalendarId, createdAt, updatedAt',
  sshCommands: '++id, syncId, name, command, description, createdAt, updatedAt',
  openshiftTemplates: '++id, syncId, name, category, yaml, icon, description, createdAt, updatedAt',
  media: '++id, syncId, filename, uploadedAt, *tags',
  gtfobinsFunctions: '++id, syncId, &funcId, label, sortOrder, isBuiltIn',
  gtfobinsExecutables: '++id, syncId, &name, *functionIds, isBuiltIn, updatedAt',
  gtfobinsContexts: '++id, syncId, &contextId, label',
  _syncState: '&[collection+key], collection, dirty, deleted',
  _syncMeta: '&key',
  _syncSnapshots: '++id, createdAt',
}).upgrade((tx) => {
  const tables = ['templates', 'documentTemplates', 'engineTemplates', 'workflows', 'kanbanBoards', 'tasks',
    'taskwarriorInstances', 'taskwarriorReports', 'customReports', 'documentCategories', 'calendarEventTemplates',
    'sshCommands', 'openshiftTemplates', 'media', 'gtfobinsFunctions', 'gtfobinsExecutables', 'gtfobinsContexts'];
  return Promise.all(tables.map((name) => tx.table(name).toCollection().modify((row) => {
    if (typeof row.syncId !== 'string' || row.syncId === '') {
      row.syncId = generateStableId();
    }
  })));
});

// 28: the open tabs of each page, shared by the account's devices
// (src/utils/openTabsSync.js): one row per tab, its id "<page>:<item>".
db.version(28).stores({
  openTabs: '&id, page, position',
});

// The synchronisation change tracker (src/sync/tracker.js) must be part of
// the middleware stack before the database opens.
installSyncTracker(db);

/**
 * Migrate existing localStorage data to IndexedDB
 */
export async function migrateFromLocalStorage() {
  try {
    console.log('[DB Migration] Starting migration from localStorage to IndexedDB...');

    // Migrate templates
    const templatesData = localStorage.getItem('jql_templates');
    if (templatesData) {
      try {
        const templates = JSON.parse(templatesData);
        if (Array.isArray(templates) && templates.length > 0) {
          await db.templates.bulkPut(templates);
          console.log(`[DB Migration] Migrated ${templates.length} templates`);
        }
      } catch (err) {
        console.error('[DB Migration] Failed to migrate templates:', err);
      }
    }

    // Migrate custom fields
    const customFieldsData = localStorage.getItem('jira_custom_fields');
    if (customFieldsData) {
      try {
        const customFields = JSON.parse(customFieldsData);
        if (Array.isArray(customFields) && customFields.length > 0) {
          await db.customFields.bulkPut(customFields);
          console.log(`[DB Migration] Migrated ${customFields.length} custom fields`);
        }
      } catch (err) {
        console.error('[DB Migration] Failed to migrate custom fields:', err);
      }
    }

    // Migrate cache data
    const cacheKeys = [
      'jira_projects',
      'jira_statuses',
      'jira_issue_types',
      'jira_priorities',
      'jira_resolutions',
    ];

    for (const key of cacheKeys) {
      const data = localStorage.getItem(key);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          await db.cache.put({
            key: key,
            data: parsed.data,
            timestamp: parsed.timestamp,
          });
          console.log(`[DB Migration] Migrated cache: ${key}`);
        } catch (err) {
          console.error(`[DB Migration] Failed to migrate ${key}:`, err);
        }
      }
    }

    // Migrate project metadata cache
    const allKeys = Object.keys(localStorage);
    const projectMetaKeys = allKeys.filter(key => key.startsWith('jira_project_meta_'));
    for (const key of projectMetaKeys) {
      const data = localStorage.getItem(key);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          await db.cache.put({
            key: key,
            data: parsed.data,
            timestamp: parsed.timestamp,
          });
          console.log(`[DB Migration] Migrated cache: ${key}`);
        } catch (err) {
          console.error(`[DB Migration] Failed to migrate ${key}:`, err);
        }
      }
    }

    // Migrate invalid projects
    const invalidProjectsData = localStorage.getItem('jira_invalid_projects');
    if (invalidProjectsData) {
      try {
        const invalidProjects = JSON.parse(invalidProjectsData);
        const entries = Object.entries(invalidProjects).map(([name, timestamp]) => ({
          name,
          timestamp,
        }));
        if (entries.length > 0) {
          await db.invalidProjects.bulkPut(entries);
          console.log(`[DB Migration] Migrated ${entries.length} invalid projects`);
        }
      } catch (err) {
        console.error('[DB Migration] Failed to migrate invalid projects:', err);
      }
    }

    // Mark migration as complete
    localStorage.setItem('db_migration_complete', 'true');
    console.log('[DB Migration] Migration completed successfully');

    return true;
  } catch (error) {
    console.error('[DB Migration] Migration failed:', error);
    return false;
  }
}

/**
 * Check if migration is needed and run it
 */
export async function initializeDatabase() {
  const migrationComplete = localStorage.getItem('db_migration_complete');

  if (!migrationComplete) {
    await migrateFromLocalStorage();
  }

  // Migrate environment variables from localStorage
  const envVarsMigrationComplete = localStorage.getItem('env_vars_migration_complete');
  if (!envVarsMigrationComplete) {
    await migrateEnvVarsFromLocalStorage();
  }

  console.log('[DB] Database initialized');
}

/**
 * Migrate environment variables from localStorage to database
 */
async function migrateEnvVarsFromLocalStorage() {
  try {
    console.log('[DB Migration] Migrating environment variables from localStorage...');

    const storedEnvVars = localStorage.getItem('workflow_env_variables');
    if (storedEnvVars) {
      try {
        const envVarsObj = JSON.parse(storedEnvVars);
        if (envVarsObj && typeof envVarsObj === 'object') {
          const entries = Object.entries(envVarsObj).map(([key, value]) => ({
            key,
            value
          }));

          if (entries.length > 0) {
            await db.envVariables.bulkPut(entries);
            console.log(`[DB Migration] Migrated ${entries.length} environment variables from localStorage`);

            // Remove from localStorage after successful migration
            localStorage.removeItem('workflow_env_variables');
          }
        }
      } catch (err) {
        console.error('[DB Migration] Failed to migrate environment variables:', err);
      }
    }

    // Mark migration as complete
    localStorage.setItem('env_vars_migration_complete', 'true');
    console.log('[DB Migration] Environment variables migration completed');

  } catch (error) {
    console.log('[DB Migration] Environment variables migration skipped:', error.message);
  }
}

// Initialize on import
initializeDatabase().catch(err => {
  console.error('[DB] Failed to initialize database:', err);
});

export default db;
