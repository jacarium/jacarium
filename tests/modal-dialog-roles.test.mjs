#!/usr/bin/env node
/**
 * Every modal is a dialog. A modal backdrop in src/ (a `fixed inset-0`
 * element with a dimming background) belongs to BaseModal, ConfirmationModal
 * or ZenSideOverlay, or carries the shared `sc-modal-backdrop` class with a
 * panel right after it that has role="dialog", aria-modal="true" and an
 * accessible name and the shared `sc-modal-panel` class - so screen readers
 * announce it, zen's Esc leaves the dialog before zen, and the reading
 * ruler works inside it (its dialog-layer detection keys on the role and
 * the backdrop class). Click-away scrims without a background (menus,
 * popovers) and the phone drawers are not modals and are not checked; the
 * few exceptions are allow-listed here with their reason.
 *
 * Also: the ruler's layer detection has the stacking-context fallback, so a
 * future modal built without the role still gets the band inside it.
 *
 * Run: node tests/modal-dialog-roles.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1500) : ''}`); if (!ok) failed++; };

const SHARED = new Set(['src/components/common/modals/BaseModal.jsx', 'src/components/common/ConfirmationModal.jsx', 'src/components/common/ZenSideOverlay.jsx']);
const ALLOW = {
  'src/components/SavedQueriesSidebar.jsx': 'the phone-width backdrop of a sidebar drawer (lg:hidden), not a modal',
  'src/components/mobile/MobileDrawer.jsx': 'the phone drawer, its own pattern',
  'src/components/mobile/MoreSheet.jsx': 'the phone bottom sheet, its own pattern',
};

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx|js)$/.test(e.name)) files.push(p); } };
walk(path.join(REPO, 'src'));

const problems = []; let sites = 0; let shared = 0;
for (const f of files) {
  const rel = path.relative(REPO, f);
  const text = fs.readFileSync(f, 'utf8');
  if (!/fixed inset-0/.test(text)) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/fixed inset-0/.test(line) || !/bg-black\//.test(line)) continue;   // a scrim without a background is no modal
    if (/^\s*\/\/|^\s*\*|^\s*\/\*/.test(line)) continue;                       // a comment
    sites++;
    if (SHARED.has(rel)) { shared++; continue; }
    if (ALLOW[rel]) continue;
    if (/lightbox\.className =/.test(line)) { if (!/setAttribute\('role', 'dialog'\)/.test(lines.slice(i, i + 8).join('\n')) || !/sc-modal-backdrop/.test(line)) problems.push(`${rel}:${i + 1} the JS-built lightbox has no role="dialog" / sc-modal-backdrop`); continue; }
    if (!/sc-modal-backdrop/.test(line)) { problems.push(`${rel}:${i + 1} a modal backdrop without the shared sc-modal-backdrop class (move it onto BaseModal, or add the class and the panel's dialog role)`); continue; }
    // the panel: the next <div after the backdrop - or the backdrop element itself when it is the dialog (a lightbox)
    const ownTag = lines.slice(Math.max(0, i - 6), i + 1).join('\n').match(/<div[^>]*$/s);
    const after = lines.slice(i + 1, i + 12).join('\n');
    const panel = after.match(/<div[^>]*>/s);
    const tag = ownTag && /role="dialog"/.test(ownTag[0]) ? ownTag[0] + after.slice(0, after.indexOf('>') + 1) : (panel ? panel[0] : '');
    if (!/role="dialog"/.test(tag) || !/aria-modal="true"/.test(tag) || !/aria-label(ledby)?=/.test(tag) || !/sc-modal-panel/.test(tag)) problems.push(`${rel}:${i + 1} the panel after the backdrop lacks role="dialog" / aria-modal / aria-label / sc-modal-panel: ${tag.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}
check(`every modal backdrop in src/ (${sites} sites, ${shared} in the shared components) is a dialog: BaseModal, or sc-modal-backdrop with a role="dialog" panel`, problems.length === 0, problems.join(' ; '));

// the shared pieces carry what the rule relies on
const base = fs.readFileSync(path.join(REPO, 'src/components/common/modals/BaseModal.jsx'), 'utf8');
check('BaseModal: the backdrop is .sc-modal-backdrop, the panel .sc-modal-panel with role="dialog" and aria-modal', /sc-modal-backdrop fixed inset-0/.test(base) && /sc-modal-panel/.test(base) && /role="dialog"/.test(base) && /aria-modal="true"/.test(base));
const ruler = fs.readFileSync(path.join(REPO, 'src/components/common/ReadingRuler.jsx'), 'utf8');
check('ReadingRuler: the dialog selector keys on the role and the shared backdrop class, and a stacking layer under the pointer is a layer too (stackLayer)', /\[role="dialog"\]\[aria-modal="true"\]/.test(ruler) && /\.sc-modal-backdrop/.test(ruler) && /function stackLayer/.test(ruler) && /stackLayer\(el\)/.test(ruler));

// the migrated modals really use BaseModal (no backdrop of their own left)
const MIGRATED = ['src/components/EditTemplateModal.jsx', 'src/components/SaveTemplateModal.jsx', 'src/components/features/documents/DocumentTemplateModal.jsx', 'src/components/ImportJQLModal.jsx', 'src/components/SaveQueryModal.jsx', 'src/components/VariableInputModal.jsx', 'src/components/modals/IconPickerModal.jsx', 'src/components/tasks/CustomReportModal.jsx'];
const notMigrated = MIGRATED.filter((rel) => { const t = fs.readFileSync(path.join(REPO, rel), 'utf8'); return !/<BaseModal/.test(t) || /fixed inset-0 bg-black/.test(t); });
check('the template, query, variable, icon and report modals are on BaseModal', notMigrated.length === 0, notMigrated.join(', '));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
