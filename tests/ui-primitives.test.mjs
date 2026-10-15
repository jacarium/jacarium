/**
 * The UI primitives and the design tokens, statically:
 *
 *  - src/components/ui/primitives.jsx exports the vocabulary (Button,
 *    IconButton, the fields, Checkbox/Radio/Toggle, Section, Card, Modal
 *    chrome, Badge, EmptyState, SubTabs ...) and the Settings dialog
 *    imports it from there;
 *  - the control tokens exist in src/index.css (@theme) and the base rules
 *    give every <button>, field, checkbox and label its radius and weight;
 *  - text buttons carry no icons: the Button primitive renders none, the
 *    Settings tabs pass none, the dialog's rail and footer are text;
 *  - the button and field class strings carry no weight class and no radius
 *    other than the control radius; menus use the menu radius.
 *
 * The sweep over every component (hard-coded weight/radius on buttons and
 * fields, raw colours) is tests/ui-consistency.test.mjs; the computed values
 * are checked in the browser by tests/tailwind-visual-regression.test.mjs
 * and tests/settings-visual-audit.test.mjs.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const prim = read('src/components/ui/primitives.jsx');
const exported = Array.from(prim.matchAll(/^export (?:function|const) (\w+)/gm)).map((m) => m[1]);
for (const name of ['Button', 'IconButton', 'ButtonRow', 'Segmented', 'Field', 'TextInput', 'Input', 'PasswordInput', 'NumberInput', 'SearchInput', 'Select', 'TextArea', 'Checkbox', 'Radio', 'Toggle', 'Section', 'SectionHeading', 'PageHeader', 'Toolbar', 'Card', 'Panel', 'Group', 'InfoRows', 'InfoRow', 'TableContainer', 'Note', 'Notice', 'StatusLine', 'Badge', 'Chip', 'EmptyState', 'SubTabs', 'Tabs', 'ModalHeader', 'ModalFooter', 'CloseButton', 'ExternalLink', 'Code', 'FIELD_CLASS', 'BUTTON']) {
  check(`primitives export ${name}`, exported.includes(name));
}
check('src/components/ui/index.js re-exports the primitives and the dialog shells', /export \* from '\.\/primitives'/.test(read('src/components/ui/index.js')) && /BaseModal/.test(read('src/components/ui/index.js')) && /ConfirmationModal/.test(read('src/components/ui/index.js')));
check('the Settings dialog imports the app-wide primitives (settings/ui.jsx is a re-export)', /export \* from '\.\.\/\.\.\/\.\.\/ui\/primitives'/.test(read('src/components/common/modals/settings/ui.jsx')));

// tokens and base rules
const css = read('src/index.css');
for (const [token, value] of [['--radius-control', 'var(--radius-sm)'], ['--radius-card', 'var(--radius-lg)'], ['--radius-menu', 'var(--radius-lg)'], ['--radius-chip', 'var(--radius-xs)'], ['--radius-check', '5px'], ['--weight-control', '400'], ['--weight-label', '400'], ['--weight-heading', '600']]) {
  const m = new RegExp(`^\\s*${token}:\\s*([^;]+);`, 'm').exec(css);
  check(`token ${token} is ${value}`, m && m[1].trim() === value, m ? m[1] : 'missing');
}
check('base rule: every button takes the control radius and the normal weight', /button, \[role="button"\] \{\s*border-radius: var\(--radius-control\);\s*font-weight: var\(--weight-control\);/.test(css));
// An unlayered rule beats the utilities layer: a global `[title] { position: ... }`
// once pulled every absolutely positioned element with a tooltip back into flow
// (the node library filter's clear button rendered under its input).
check('no global [title] rule positions tooltip-bearing elements', !/^\s*\[title\]\s*\{[^}]*position\s*:/m.test(css));
check('base rule: text fields, selects and textareas take the control radius and the normal weight', /input:not\(\[type="checkbox"\]\)[^{]*,\s*select,\s*textarea \{\s*border-radius: var\(--radius-control\);\s*font-weight: var\(--weight-control\);/.test(css));
check('base rule: checkboxes take the check radius and the accent colour, radios are round', /input\[type="checkbox"\] \{ border-radius: var\(--radius-check\); accent-color: var\(--os-blue\); \}/.test(css) && /input\[type="radio"\] \{ border-radius: 9999px; accent-color: var\(--os-blue\); \}/.test(css));
check('base rule: labels take the label weight', /label \{ font-weight: var\(--weight-label\); \}/.test(css));

// the primitives' classes
const buttonBlock = prim.slice(prim.indexOf('const BTN ='), prim.indexOf('export function Button'));
check('the button classes carry no weight class', !/font-(medium|semibold|bold)/.test(buttonBlock));
check('the button classes carry no radius other than the control radius (rounded-sm) and the link', !/rounded-(xs|md|lg|xl|2xl|3xl|none)\b/.test(buttonBlock));
check('the field class carries no weight class and the control radius', !/font-(medium|semibold|bold)/.test(prim.slice(prim.indexOf('export const FIELD_CLASS'), prim.indexOf('export function Field'))) && /FIELD_CLASS = 'sc-field [^']*rounded-sm/.test(prim));
check('the Button primitive renders no icon (text buttons carry none); IconButton is the icon-only control', !/export function Button\([^)]*icon/.test(prim) && /export function IconButton\(\{ icon: Icon, label/.test(prim) && /aria-label=\{label\}/.test(prim));
check('the Section heading is text (no icon prop rendered)', !/export function Section\([^)]*icon/.test(prim) && !/\{Icon && <Icon[^>]*>\}\s*<h3 className="sc-section-title/.test(prim));
check('the Field label is normal weight', /className="sc-label block text-xs text-os-text-primary mb-1\.5"/.test(prim));

// the Settings dialog
const settingsFiles = execFileSync('git', ['ls-files', 'src/components/common/modals/settings', 'src/components/common/modals/SettingsModal.jsx', 'src/components/common/modals/CloudModal.jsx'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
const iconProps = [];
for (const f of settingsFiles) { const s = read(f); for (const m of s.matchAll(/<(Button|Section|InfoRow)\b[^>]*\sicon=\{/g)) iconProps.push(`${f}: <${m[1]} icon=`); }
check('no Settings tab passes an icon to Button, Section or InfoRow', iconProps.length === 0, iconProps.slice(0, 5).join(' ; '));
const modal = read('src/components/common/modals/SettingsModal.jsx');
check('the Settings rail tabs are text only', !/<category\.icon/.test(modal) && /sc-rail-tab/.test(modal));
check('the Settings header and footer use ModalHeader and Button (no Save icon)', /<ModalHeader title="Application Settings" onClose=\{onClose\} \/>/.test(modal) && /<Button variant="primary" size="lg" onClick=\{handleSave\}/.test(modal) && !/<Save size/.test(modal));
check('the confirmation dialog uses the Button primitive and the field class', /<Button variant=\{config\.variant\} size="lg" onClick=\{handleConfirm\}/.test(read('src/components/common/modals/ConfirmationModal.jsx')) && /FIELD_CLASS/.test(read('src/components/common/modals/ConfirmationModal.jsx')));
check('context and hamburger menus use the menu radius (rounded-lg)', /rounded-lg py-1\.5/.test(read('src/components/common/menus/ContextMenu.jsx')) && /rounded-lg/.test(read('src/components/common/menus/HamburgerMenu.jsx')));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
