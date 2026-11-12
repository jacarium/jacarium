#!/usr/bin/env node
/**
 * The shared popup placement (src/utils/popupPlacement.js, the hook
 * src/hooks/usePopupPosition.js): every context menu, dropdown and popover
 * stays inside the window - below / beside its anchor when it fits, flipped
 * above / to the other side when it does not, clamped with a capped height
 * (scrolling inside) when it fits nowhere. The pure function's answers, the
 * caret popups' wrapper (unchanged numbers), and a sweep: each menu and
 * dropdown in the sources goes through the hook (ContextMenu, HamburgerMenu,
 * DropdownPanel, the rail's ... menu, the tab bar's overflow panel, the
 * workflow canvas' menus, the date pickers, the caret popups), none keeps a
 * guessed size or its own clamp.
 *
 * Run: node tests/popup-placement.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };

const { placePopup, POPUP_GAP, POPUP_MARGIN } = await import(path.join(REPO, 'src/utils/popupPlacement.js'));
const { placeCaretPopup, CARET_POPUP_GAP, CARET_POPUP_MARGIN } = await import(path.join(REPO, 'src/utils/caretPopup.js'));
const viewport = { width: 1200, height: 800 };
const j = (o) => JSON.stringify(o);

console.log('--- 1. a menu at the pointer ---');
let p = placePopup({ anchor: { left: 100, top: 100 }, popup: { width: 220, height: 300 }, viewport });
check('1. room below and to the right: the menu opens at the pointer (a 2px gap), at its full height', p.placement === 'below' && p.left === 100 && p.top === 100 + POPUP_GAP && p.maxHeight === 300, j(p));
p = placePopup({ anchor: { left: 100, top: 700 }, popup: { width: 220, height: 300 }, viewport });
check('1. no room below, room above: it flips above the pointer, its bottom at the gap', p.placement === 'above' && p.top + p.maxHeight === 700 - POPUP_GAP && p.maxHeight === 300, j(p));
p = placePopup({ anchor: { left: 1100, top: 100 }, popup: { width: 220, height: 300 }, viewport });
check('1. near the right edge: it flips to end at the pointer', p.left === 1100 - 220 && p.placement === 'below', j(p));
p = placePopup({ anchor: { left: 100, top: 400 }, popup: { width: 220, height: 900 }, viewport });
check('1. taller than either side: the roomier side, capped to the room (it scrolls inside), inside the margin', p.maxHeight === 800 - 400 - POPUP_GAP - POPUP_MARGIN && p.placement === 'below' && p.top === 400 + POPUP_GAP && p.top + p.maxHeight === 800 - POPUP_MARGIN, j(p));
p = placePopup({ anchor: { left: 100, top: 500 }, popup: { width: 220, height: 900 }, viewport });
check('1. ...above when there is more room above', p.placement === 'above' && p.top === POPUP_MARGIN && p.top + p.maxHeight === 500 - POPUP_GAP, j(p));
p = placePopup({ anchor: { left: 150, top: 100 }, popup: { width: 1400, height: 100 }, viewport });
check('1. wider than the window: the left margin wins', p.left === POPUP_MARGIN, j(p));
p = placePopup({ anchor: { left: 100, top: -50 }, popup: { width: 220, height: 100 }, viewport });
check('1. a pointer scrolled above the window anchors at the margin', p.top === POPUP_MARGIN + POPUP_GAP, j(p));

console.log('\n--- 2. a dropdown under its button, a menu beside the rail ---');
const button = { left: 900, top: 40, right: 1000, bottom: 72 };
p = placePopup({ anchor: button, popup: { width: 240, height: 200 }, viewport, align: 'end', gap: 4 });
check('2. align end: the dropdown ends at the button\'s right, under it with the gap', p.left === 1000 - 240 && p.top === 72 + 4 && p.placement === 'below', j(p));
p = placePopup({ anchor: { left: 10, top: 40, right: 60, bottom: 72 }, popup: { width: 240, height: 200 }, viewport, align: 'end', gap: 4 });
check('2. align end at the left edge: it flips to start at the button', p.left === 10, j(p));
p = placePopup({ anchor: { left: 900, top: 700, right: 1000, bottom: 732 }, popup: { width: 240, height: 200 }, viewport, align: 'end', gap: 4 });
check('2. a button near the bottom: the dropdown opens above it', p.placement === 'above' && p.top + p.maxHeight === 700 - 4, j(p));
p = placePopup({ anchor: { left: 1180, top: 40, right: 1200, bottom: 72 }, popup: { width: 240, height: 200 }, viewport, align: 'end', margin: 0 });
check('2. margin 0 (the tab strip\'s panel): flush with the window\'s edge', p.left === 1200 - 240, j(p));
const rail = { left: 8, top: 600, right: 56, bottom: 648 };
p = placePopup({ anchor: rail, popup: { width: 200, height: 300 }, viewport, side: 'right', gap: 8 });
check('2. side right: beside the rail button, moved up so it ends inside the window', p.placement === 'right' && p.left === 56 + 8 && p.top === 800 - POPUP_MARGIN - 300 && p.maxHeight === 300, j(p));
p = placePopup({ anchor: rail, popup: { width: 200, height: 900 }, viewport: { width: 1200, height: 520 }, side: 'right', gap: 8 });
check('2. side right in a short window: capped to the window less the margins, at the top margin', p.top === POPUP_MARGIN && p.maxHeight === 520 - 2 * POPUP_MARGIN, j(p));
p = placePopup({ anchor: { left: 1100, top: 100, right: 1150, bottom: 148 }, popup: { width: 200, height: 100 }, viewport, side: 'right', gap: 8 });
check('2. side right with no room on the right: it opens to the left of the anchor', p.placement === 'left' && p.left === 1100 - 8 - 200, j(p));

console.log('\n--- 3. the caret popups keep their numbers ---');
const caret = { left: 100, top: 120, bottom: 138 };
let c = placeCaretPopup({ caret, popup: { width: 380, height: 350 }, viewport: { width: 1280, height: 800 } });
check('3. room below: under the caret line at the caret gap, full height, at the caret\'s left', c.placement === 'below' && c.top === 138 + CARET_POPUP_GAP && c.maxHeight === 350 && c.left === 100, j(c));
c = placeCaretPopup({ caret: { left: 100, top: 700, bottom: 718 }, popup: { width: 380, height: 350 }, viewport: { width: 1280, height: 800 } });
check('3. no room below: above the caret line, its bottom at the gap', c.placement === 'above' && c.top + c.maxHeight === 700 - CARET_POPUP_GAP && c.maxHeight === 350, j(c));
c = placeCaretPopup({ caret: { left: 1200, top: 120, bottom: 138 }, popup: { width: 380, height: 350 }, viewport: { width: 1280, height: 800 } });
check('3. near the right edge: clamped (no flip for a caret), inside the caret margin', c.left === 1280 - 380 - CARET_POPUP_MARGIN, j(c));

console.log('\n--- 4. the sources: one placement for every menu and dropdown ---');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => /\.jsx?$/.test(f) && fs.existsSync(path.join(REPO, f)));
const hookUsers = files.filter((f) => /usePopupPosition\(/.test(read(f)));
check('4. the hook places: ContextMenu, HamburgerMenu, DropdownPanel, CategorySubmenu, the rail\'s ... menu, the tab bar\'s overflow panel, the workflow node menu and node search, the date pickers, the caret popups',
  ['src/components/common/menus/ContextMenu.jsx', 'src/components/common/menus/HamburgerMenu.jsx', 'src/components/common/menus/DropdownPanel.jsx', 'src/components/common/menus/CategorySubmenu.jsx', 'src/components/CompactSidebar.jsx', 'src/components/features/documents/TabBar.jsx', 'src/components/workflow/NodeContextMenu.jsx', 'src/components/workflow/NodeSearchMenu.jsx', 'src/components/common/inputs/DatePicker.jsx', 'src/components/common/inputs/DateTimePicker.jsx', 'src/components/features/documents/useCaretPopup.js'].every((f) => hookUsers.includes(f)), hookUsers.join());
// a fixed menu placed by hand: a `fixed` element with role="menu" whose file never calls the hook. Left alone on
// purpose: the phone's sheets (MoreSheet, MobileTaskFilters: full-width, placed by the stylesheet), the zen panels
// fan (centred at the edge by the stylesheet, capped there), and the editor's ToolbarMenu, which already measures
// itself, caps its height under the phone's bottom bar / the on-screen keyboard and scrolls
const OWN_PLACE = new Set(['src/components/mobile/MobileMenuChrome.jsx', 'src/components/mobile/MoreSheet.jsx', 'src/components/mobile/MobileTaskFilters.jsx', 'src/components/common/ZenPanelsTab.jsx', 'src/components/features/documents/ToolbarMenu.jsx']);
const handPlaced = files.filter((f) => !hookUsers.includes(f) && !OWN_PLACE.has(f) && /role="menu"/.test(read(f)) && /className=[`"'][^`"']*\bfixed\b/.test(read(f)) && !/<ContextMenu\b|<HamburgerMenu\b/.test(read(f)));
check('4. no other fixed role="menu" is placed by hand', handPlaced.length === 0, handPlaced.join());
// the pages that draw their own context-menu div (sc-context-menu fixed ..., ref={contextMenuRef}): useContextMenu places
// it from the same hook, so each of those files must take its ref from useContextMenu
const ownDiv = files.filter((f) => /className="sc-context-menu fixed /.test(read(f)));
check(`4. the pages drawing their own context-menu div (${ownDiv.length}: AI chat, search, calendars, tasks, calendar templates, the document and template sidebars, kanban, the workflow menu, the OpenShift template tool) take useContextMenu, which places it, or call the hook themselves`, ownDiv.length >= 10 && ownDiv.every((f) => (/useContextMenu\(\)/.test(read(f)) && /ref=\{contextMenuRef\}/.test(read(f))) || /usePopupPosition\(/.test(read(f))) && /usePopupPosition\(contextMenuRef, \{ open: contextMenu\.visible, anchor: \(\) => \(\{ left: contextMenu\.x, top: contextMenu\.y \}\)/.test(read('src/hooks/useContextMenu.js')), ownDiv.map((f) => `${f}:${/useContextMenu\(\)/.test(read(f))}/${/usePopupPosition\(/.test(read(f))}`).join());
check('4. ToolbarMenu (left to its own placement) still measures, caps and scrolls', /maxHeight: Math\.max\(120, limit - top - 8\)/.test(read('src/components/features/documents/ToolbarMenu.jsx')) && /overflow-y-auto/.test(read('src/components/features/documents/ToolbarMenu.jsx')));
const topFull = files.filter((f) => /className="[^"]*\babsolute top-full\b[^"]*"/.test(read(f)) && f !== 'src/components/common/menus/DropdownPanel.jsx');
check('4. no inline dropdown is written as absolute top-full any more (the AI chat model pickers and the task row pickers are DropdownPanels; the tab bar\'s phone menu is a sheet)', topFull.every((f) => f === 'src/components/features/documents/TabBar.jsx'), topFull.join());
const guessed = files.filter((f) => /MENU_(WIDTH|HEIGHT)\s*=|menuHeight = 280/.test(read(f)) && f !== 'src/hooks/useContextMenu.js');
check('4. no menu keeps a guessed size for its own clamp', guessed.length === 0, guessed.join());
check('4. useContextMenu no longer nudges the menu itself (ContextMenu places it); useDropdownMenu hands the button\'s rectangle and the alignment on', !/menuRect\.right > window\.innerWidth/.test(read('src/hooks/useContextMenu.js')) && /anchor: \{ left: rect\.left, top: rect\.top, right: rect\.right, bottom: rect\.bottom \}/.test(read('src/hooks/useContextMenu.js')));
check('4. ContextMenu re-places from the pointer as it renders and resizes; a capped menu scrolls inside and its arrow keys still focus (focus scrolls the item into view)', /usePopupPosition\(inner, \{ open: true, anchor: \(\) => \(\{ left: x, top: y \}\), deps: \[x, y\] \}\)/.test(read('src/components/common/menus/ContextMenu.jsx')) && /ResizeObserver/.test(read('src/hooks/usePopupPosition.js')) && /overflowY = 'auto'/.test(read('src/hooks/usePopupPosition.js')));
check('4. zen\'s "Navigation" overlay lists its pages and panels in a scrolling list inside a zen side overlay (no fan beside the tab any more)', /\.sc-zen-goto-item \{ display: flex;/.test(read('src/index.css')) && !/sc-zen-fan/.test(read('src/index.css')) && /<ZenSideOverlay side="right"/.test(read('src/components/common/ZenGoTo.jsx')));
check('4. the editor\'s right-click menu is the app\'s own (TextSelectionMenu on ContextMenu), never a native Menu.popup', /<ContextMenu /.test(read('src/components/features/documents/TextSelectionMenu.jsx')) && !/Menu\.popup|buildFromTemplate/.test(read('electron/spellcheck.cjs')));

console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
