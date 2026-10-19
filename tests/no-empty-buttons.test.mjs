#!/usr/bin/env node
/**
 * No button is left with nothing inside it.
 *
 * Two clean-ups that took icons out of text buttons ("no icons in text
 * buttons", "text buttons and menus: text only") also emptied three
 * icon-only buttons, which then rendered as invisible click targets:
 *   - the task's done checkbox (TaskItem) - tasks could only be deleted
 *   - "Check the AI backend again" on the AI chat's offline banner
 *   - "Sync active calendar" in the Calendars sidebar (not restored:
 *     moved into the sidebar's hamburger menu instead, see below)
 *
 * This test scans every .jsx file under src/ for a <button>, <Button> or
 * <IconButton> whose children are only whitespace, and checks that the
 * restored buttons show their icon and carry an accessible name.
 *
 * Run:  node tests/no-empty-buttons.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ` | ${detail}` : ''}`);
  if (!ok) failed++;
};

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsx')) files.push(p);
  }
};
walk(path.join(REPO, 'src'));

const EMPTY = /<(button|Button|IconButton)\b(?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*>\s*<\/\1>/g;
const empty = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(EMPTY)) {
    empty.push(`${path.relative(REPO, f)}:${src.slice(0, m.index).split('\n').length}`);
  }
}
check(`no empty button in ${files.length} .jsx files`, empty.length === 0, empty.join(', '));

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const task = read('src/components/tasks/TaskItem.jsx');
check('the task checkbox shows a circle, and a check circle when done', /isCompleted \? \(\s*<CheckCircle\b[\s\S]*?\) : \(\s*<Circle\b/.test(task));
check('the task checkbox is named "Mark as done" / "Mark as not done"', /aria-label=\{isCompleted \? 'Mark as not done' : 'Mark as done'\}/.test(task));
const ai = read('src/components/common/AIChatSidebar.jsx');
check('the offline banner\'s re-check button shows its icon and has a name', /aria-label="Check the AI backend again"\s*>\s*<RefreshCw\b/.test(ai));
// The Calendars sidebar's header sync button was not restored: no sidebar
// header carries a sync/refresh button any more. "Sync active calendar" is
// a hamburger-menu item (disabled, "Syncing..." while busy); the header
// keeps the status dot. tests/calendar-sync-menu.test.mjs clicks it.
const cal = read('src/components/features/calendars/CalendarSidebar.jsx');
const calHeader = (cal.match(/<SidebarHeader[\s\S]*?\/>/) || [''])[0];
check('the Calendars sidebar header has no sync button (status dot only)', calHeader.length > 0 && !/actions=/.test(calHeader) && !/Sync active calendar/.test(calHeader) && /status=\{syncStatus\}/.test(calHeader) && !/\bRefreshCw\b/.test(cal));
check('the Calendars menu has "Sync active calendar" (Syncing... and disabled while syncing) calling onSyncCalendar',
  /<HamburgerMenuItem\s+icon=\{MENU_ICONS\.syncToCloud\}\s+label=\{isSyncing \? 'Syncing…' : 'Sync active calendar'\}\s+disabled=\{isSyncing\}\s+onClick=\{\(\) => \{\s*onSyncCalendar && onSyncCalendar\(\);/.test(cal));
const docs = read('src/components/features/documents/DocumentSidebar.jsx');
const docsHeader = (docs.match(/<SidebarHeader[\s\S]*?\n      \/>/) || [''])[0];
check('the Documents sidebar header has no sync/refresh button either (selection mode and add only, status dot kept)',
  docsHeader.length > 0 && !/[Ss]ync|[Rr]efresh|RefreshCw/.test(docsHeader) && /status=\{centralServerStatus\}/.test(docsHeader));

console.log();
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('All checks passed');
