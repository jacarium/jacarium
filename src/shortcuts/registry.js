/**
 * The keyboard shortcut registry: every action a chord can trigger, its
 * default chord per platform, where it applies and who fires it. Nothing
 * else in the app hard-codes a chord: the renderer's handlers subscribe
 * by action id (src/shortcuts/useShortcut.js), the desktop menu takes its
 * accelerators from here (electron/shortcuts.cjs), the Settings >
 * Shortcuts tab edits the overrides (src/shortcuts/store.js) and the
 * tooltips ask for the current label.
 *
 * This file is plain ESM with no imports. The main process cannot import
 * it, so electron/shortcuts-registry.cjs is GENERATED from it
 * (scripts/sync-shortcuts-registry.mjs; tests/shortcuts-registry.test.mjs
 * fails when the two drift). Keep it dependency-free and top-level
 * `export const` / `export function` only.
 *
 * A chord is a string of '+'-joined tokens: the modifiers in the order
 * Mod, Ctrl, Alt, Shift (Mod is Command on a Mac and Control elsewhere;
 * Ctrl is the Control key on a Mac only; Meta is the Super/Windows key,
 * never bindable) then one key token: the physical key by KeyboardEvent
 * code (KeyA..KeyZ, Digit0..Digit9, F1..F12, Comma, Period, Slash, Minus,
 * Equal, BracketLeft, BracketRight, Semicolon, Quote, Backquote, Backslash)
 * or, for the keys that mean the same on every layout, the key name
 * (Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp...). Matching is
 * by code, so a binding follows the physical key across layouts; labels
 * show the layout's character for that key (formatChord with a
 * KeyboardLayoutMap).
 *
 * Scopes, innermost first: 'editor' (the document editor's textarea has
 * focus), 'workflow-canvas' (the workflow page, focus not in a field),
 * 'page:documents' / 'page:search' (that page is shown), 'global'.
 *
 * Owner: 'renderer' - a window keydown handler fires it; 'menu' - the
 * desktop application menu's accelerator fires it (the renderer handles it
 * only in a browser, where there is no menu); an action with a `role` is a
 * fixed Electron menu role (Reload, Full screen): never rebindable, listed
 * so its chord counts as taken. `desktopOnly` marks the menu actions that
 * have no counterpart in a browser at all (Settings, Toggle sidebar, zoom,
 * the roles): a browser neither lists them nor counts their chords.
 */
export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'jacarium.shortcuts';

export const GROUPS = [
  { id: 'app', label: 'App' },
  { id: 'pages', label: 'Pages' },
  { id: 'editor', label: 'Editor' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'jql', label: 'JQL' },
];

export const SCOPES = {
  global: 'Everywhere',
  editor: 'When the document editor has focus',
  'workflow-canvas': 'On the workflow canvas',
  'page:documents': 'On the Documents page',
  'page:search': 'On the JQL Search page',
};

const SCOPE_PRIORITY = { editor: 0, 'workflow-canvas': 1, 'page:documents': 2, 'page:search': 2, global: 3 };

const PAGES = [
  ['documents', 'Documents'], ['calendars', 'Calendars'], ['kanban', 'Kanban'], ['tasks', 'Tasks'],
  ['workflow', 'Workflow Builder'], ['diagnostics', 'Diagnostics'], ['search', 'JQL Search'], ['tools', 'Tools'],
];

const same = (chord) => ({ mac: chord, other: chord });

export const ACTIONS = [
  // --- App ---
  { id: 'app.palette', label: 'Command palette', group: 'app', scope: 'global', owner: 'renderer', defaults: same('Mod+KeyK') },
  { id: 'app.findInFiles', label: 'Find in files', group: 'app', scope: 'page:documents', owner: 'renderer', defaults: same('Mod+Shift+KeyF') },
  { id: 'app.settings', label: 'Open Settings', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, defaults: same('Mod+Comma') },
  { id: 'app.toggleSidebar', label: 'Toggle sidebar', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, defaults: same('Mod+KeyB') },
  { id: 'app.zoomIn', label: 'Zoom in', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, defaults: same('Mod+Equal'), aliases: same(['Mod+Shift+Equal']) },
  { id: 'app.zoomOut', label: 'Zoom out', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, defaults: same('Mod+Minus') },
  { id: 'app.zoomReset', label: 'Actual size', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, defaults: same('Mod+Digit0') },
  { id: 'app.reload', label: 'Reload', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, role: 'reload', rebindable: false, defaults: same('Mod+KeyR') },
  { id: 'app.forceReload', label: 'Force reload', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, role: 'forceReload', rebindable: false, defaults: same('Mod+Shift+KeyR') },
  { id: 'app.fullscreen', label: 'Full screen', group: 'app', scope: 'global', owner: 'menu', desktopOnly: true, role: 'togglefullscreen', rebindable: false, defaults: { mac: 'Mod+Ctrl+KeyF', other: 'F11' } },
  // --- Pages (unassigned by default: the former Ctrl/Cmd+Shift+<letter> chords collided with copy in Linux terminals) ---
  ...PAGES.map(([page, label]) => ({ id: `page.${page}`, label: `Open ${label}`, group: 'pages', scope: 'global', owner: 'menu', page, defaults: same(null) })),
  // --- Editor ---
  { id: 'editor.find', label: 'Find in document', group: 'editor', scope: 'editor', owner: 'renderer', defaults: same('Mod+KeyF') },
  { id: 'editor.replace', label: 'Find and replace', group: 'editor', scope: 'editor', owner: 'renderer', defaults: same(null) },
  { id: 'editor.bold', label: 'Bold', group: 'editor', scope: 'editor', owner: 'renderer', defaults: same(null) },
  { id: 'editor.italic', label: 'Italic', group: 'editor', scope: 'editor', owner: 'renderer', defaults: same('Mod+KeyI') },
  { id: 'editor.insertLink', label: 'Insert link', group: 'editor', scope: 'editor', owner: 'renderer', defaults: same(null) },
  { id: 'editor.indent', label: 'Indent list item', group: 'editor', scope: 'editor', owner: 'renderer', rebindable: false, defaults: same('Tab') },
  { id: 'editor.outdent', label: 'Outdent list item', group: 'editor', scope: 'editor', owner: 'renderer', rebindable: false, defaults: same('Shift+Tab') },
  // --- Workflow canvas ---
  { id: 'workflow.undo', label: 'Undo', group: 'workflow', scope: 'workflow-canvas', owner: 'renderer', defaults: same('Mod+KeyZ') },
  { id: 'workflow.redo', label: 'Redo', group: 'workflow', scope: 'workflow-canvas', owner: 'renderer', defaults: same('Mod+Shift+KeyZ'), aliases: { mac: [], other: ['Mod+KeyY'] } },
  { id: 'workflow.fit', label: 'Fit workflow into view', group: 'workflow', scope: 'workflow-canvas', owner: 'renderer', plainKeys: true, defaults: same('KeyF'), aliases: same(['Shift+Digit1']) },
  { id: 'workflow.quickAdd', label: 'Quick-add a node at the pointer', group: 'workflow', scope: 'workflow-canvas', owner: 'renderer', plainKeys: true, defaults: same('Tab') },
  { id: 'workflow.copyNodes', label: 'Copy selected nodes', group: 'workflow', scope: 'workflow-canvas', owner: 'renderer', defaults: same('Mod+KeyC') },
  { id: 'workflow.pasteNodes', label: 'Paste nodes', group: 'workflow', scope: 'workflow-canvas', owner: 'renderer', defaults: same('Mod+KeyV') },
  // --- JQL Search ---
  { id: 'jql.openInJira', label: 'Open the query in Jira', group: 'jql', scope: 'page:search', owner: 'renderer', defaults: same('Mod+Enter') },
];

const BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

/** The action with this id, or null. */
export function actionById(id) {
  return BY_ID[id] || null;
}

/** 'mac' | 'other' - the defaults column for an OS ('mac' | 'linux' | 'win'). */
export function platformOf(os) {
  return os === 'mac' ? 'mac' : 'other';
}

/** The action's default chord on a platform (null = unassigned). */
export function defaultChord(action, platform) {
  return action.defaults ? action.defaults[platform] ?? null : null;
}

/** The fixed extra chords an action also answers to (Redo's Ctrl+Y, Fit's Shift+1, Zoom in's Shift+=). */
export function aliasesOf(action, platform) {
  return (action.aliases && action.aliases[platform]) || [];
}

export function isRebindable(action) {
  return action.rebindable !== false && !action.role;
}

/* ------------------------------------------------------------------ */
/* Chords                                                              */
/* ------------------------------------------------------------------ */

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
const CODE_KEYS = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Comma|Period|Slash|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Backslash|IntlBackslash)$/;
const NAMED_KEYS = /^(Enter|Tab|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert)$/;

/** { mods: string[] (in canonical order), key } or null for a malformed chord. */
export function parseChord(chord) {
  if (typeof chord !== 'string' || !chord) return null;
  const parts = chord.split('+');
  const key = parts.pop();
  if (!CODE_KEYS.test(key) && !NAMED_KEYS.test(key)) return null;
  const mods = [];
  for (const p of parts) {
    if (!MODIFIERS.includes(p) || mods.includes(p)) return null;
    mods.push(p);
  }
  const ordered = MODIFIERS.filter((m) => mods.includes(m));
  if (ordered.join() !== mods.join()) return null;
  return { mods: ordered, key };
}

export function isChord(chord) {
  return parseChord(chord) !== null;
}

/** The chord a keydown event spells on a platform ('mac' | 'other'), or null for a lone modifier / unknown key. */
export function chordFromEvent(e, platform) {
  const mods = [];
  if (platform === 'mac') {
    if (e.metaKey) mods.push('Mod');
    if (e.ctrlKey) mods.push('Ctrl');
  } else {
    if (e.ctrlKey) mods.push('Mod');
    if (e.metaKey) mods.push('Meta');
  }
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = keyTokenOf(e);
  if (!key) return null;
  return [...MODIFIERS.filter((m) => mods.includes(m)), key].join('+');
}

function keyTokenOf(e) {
  const code = e.code || '';
  const key = e.key || '';
  if (/^(Control|Shift|Alt|Meta|OS|AltGraph|CapsLock|Fn|Dead|Unidentified)$/.test(key) || /^(Control|Shift|Alt|Meta|OS)(Left|Right)$/.test(code)) return null;
  if (code === 'NumpadEnter') return 'Enter';
  if (CODE_KEYS.test(code)) return code;
  if (key === ' ' || code === 'Space') return 'Space';
  if (NAMED_KEYS.test(key)) return key;
  if (NAMED_KEYS.test(code)) return code;
  // a key the code does not name (a browser without KeyboardEvent.code): a single character
  if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`;
  return null;
}

/** Does this keydown spell exactly this chord? */
export function matchesChord(e, chord, platform) {
  return !!chord && chordFromEvent(e, platform) === chord;
}

/** Does the event carry Command (Mac) / Control (elsewhere) or Control on a Mac - a chord modifier, not plain typing? */
export function hasChordModifier(e) {
  return !!(e.metaKey || e.ctrlKey);
}

/** Any modifier at all (Shift and Alt included)? */
export function hasAnyModifier(e) {
  return !!(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
}

/** Does the event carry the platform's main modifier (Command on a Mac, Control elsewhere) - and only that one? */
export function hasMod(e, mac) {
  return mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

const MAC_MODS = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const OTHER_MODS = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' };
const OTHER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
const MAC_NAMED = { Enter: '↩', Tab: '⇥', Escape: '⎋', Backspace: '⌫', Delete: '⌦', Space: '␣', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟' };
const OTHER_NAMED = { Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PgUp', PageDown: 'PgDn' };
const PUNCT = { Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\', IntlBackslash: '\\' };

/**
 * The character a key token shows: the layout's character for a letter or
 * punctuation key when a KeyboardLayoutMap is given (AZERTY shows A for
 * KeyQ), the US character otherwise; digits always show their digit.
 */
export function keyLabel(token, { mac = false, layout = null } = {}) {
  if (!token) return '';
  if (/^Key[A-Z]$/.test(token)) {
    const fromLayout = layout && typeof layout.get === 'function' ? layout.get(token) : null;
    return (fromLayout && fromLayout.length === 1 ? fromLayout : token.slice(3)).toUpperCase();
  }
  if (/^Digit[0-9]$/.test(token)) return token.slice(5);
  if (PUNCT[token]) {
    const fromLayout = layout && typeof layout.get === 'function' ? layout.get(token) : null;
    return fromLayout && fromLayout.length === 1 ? fromLayout : PUNCT[token];
  }
  if (mac && MAC_NAMED[token]) return MAC_NAMED[token];
  if (!mac && OTHER_NAMED[token]) return OTHER_NAMED[token];
  return token;
}

/** The chord as the user sees it: "⌃⌥⇧⌘K" on a Mac, "Ctrl+Alt+Shift+K" elsewhere; '' for null. */
export function formatChord(chord, { mac = false, layout = null } = {}) {
  const parsed = parseChord(chord);
  if (!parsed) return '';
  const key = keyLabel(parsed.key, { mac, layout });
  if (mac) return MAC_ORDER.filter((m) => parsed.mods.includes(m)).map((m) => MAC_MODS[m]).join('') + key;
  return [...OTHER_ORDER.filter((m) => parsed.mods.includes(m)).map((m) => OTHER_MODS[m]), key].join('+');
}

/** "Mod+B" / "Shift+Tab" / "Mod+Alt+1" (the older platform-free spelling) as a canonical chord. */
export function legacyToChord(spelling) {
  const parts = String(spelling).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const key = /^[a-z]$/i.test(last) ? `Key${last.toUpperCase()}` : /^[0-9]$/.test(last) ? `Digit${last}` : last;
  const mods = MODIFIERS.filter((m) => parts.slice(0, -1).includes(m));
  return [...mods, key].join('+');
}

/** The Electron accelerator for a chord ("CommandOrControl+Shift+F"), or null. */
export function toAccelerator(chord) {
  const parsed = parseChord(chord);
  if (!parsed) return null;
  const mods = parsed.mods.map((m) => ({ Mod: 'CommandOrControl', Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' }[m]));
  const key = parsed.key;
  const name = /^Key[A-Z]$/.test(key) ? key.slice(3) : /^Digit[0-9]$/.test(key) ? key.slice(5) : PUNCT[key] ? PUNCT[key] : { Enter: 'Return', Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[key] || key;
  return [...mods, name].join('+');
}

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

/** { actionId: chord | null } for a platform: the overrides over the defaults. */
export function resolveBindings(overrides, platform) {
  const out = {};
  for (const action of ACTIONS) {
    const own = overrides && Object.prototype.hasOwnProperty.call(overrides, action.id) && isRebindable(action) ? overrides[action.id] : undefined;
    out[action.id] = own === undefined ? defaultChord(action, platform) : own;
  }
  return out;
}

/** The actions that exist in this build (a browser has no menu: no Settings / Toggle sidebar / zoom / roles). */
export function actionsForBuild(build) {
  return build === 'web' ? ACTIONS.filter((a) => !a.desktopOnly) : ACTIONS;
}

/** The actions a chord fires on this platform (bindings and fixed aliases), innermost scope first. */
export function actionsForChord(chord, bindings, platform) {
  return ACTIONS.filter((a) => bindings[a.id] === chord || aliasesOf(a, platform).includes(chord))
    .sort((a, b) => SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope]);
}

export function scopePriority(scope) {
  return SCOPE_PRIORITY[scope] ?? 99;
}

/** Can two actions be reached from the same keystroke? (The editor lives on the Documents page.) */
export function scopesOverlap(a, b) {
  if (a === b || a === 'global' || b === 'global') return true;
  const pair = [a, b].sort().join('|');
  return pair === 'editor|page:documents';
}

/**
 * Stored overrides, cleaned: only known rebindable actions, chords with a
 * valid spelling (null = explicitly unassigned). Returns the kept overrides
 * and the ids that were dropped.
 */
export function normalizeOverrides(raw) {
  const overrides = {};
  const dropped = [];
  if (raw && typeof raw === 'object') {
    for (const [id, chord] of Object.entries(raw)) {
      const action = actionById(id);
      if (!action || !isRebindable(action) || !(chord === null || isChord(chord))) { dropped.push(id); continue; }
      overrides[id] = chord;
    }
  }
  return { overrides, dropped };
}

/** Only the differences from the defaults are stored. */
export function diffOverrides(bindings, platform) {
  const out = {};
  for (const action of ACTIONS) {
    if (!isRebindable(action)) continue;
    const chord = bindings[action.id] ?? null;
    if (chord !== defaultChord(action, platform)) out[action.id] = chord;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Validation: reserved chords and conflicts                           */
/* ------------------------------------------------------------------ */

// The OS or window manager takes these before any app sees them
const OS_RESERVED = {
  mac: ['Mod+KeyQ', 'Mod+KeyW', 'Mod+KeyH', 'Mod+KeyM', 'Mod+Tab', 'Mod+Space', 'Ctrl+Mod+KeyQ', 'Mod+Alt+Escape', 'Mod+Shift+KeyQ', 'Mod+Alt+KeyH'],
  linux: ['Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Mod+Alt+Delete', 'Mod+Alt+KeyT'],
  win: ['Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Mod+Alt+Delete', 'Mod+Shift+Escape'],
};
// A browser keeps these from the page (it never sees them, or cannot cancel them)
const BROWSER_RESERVED = ['Mod+KeyT', 'Mod+KeyW', 'Mod+KeyN', 'Mod+KeyL', 'Mod+Shift+KeyT', 'Mod+Shift+KeyN', 'Mod+Shift+KeyW', 'Mod+Shift+KeyK', 'Mod+Shift+KeyJ', 'Mod+Shift+KeyI', 'Mod+Shift+KeyC', 'Mod+Tab', 'Mod+Shift+Tab', 'F12', 'Mod+KeyQ'];
// Habits on Linux: copy/paste and tabs in terminals and GTK apps
const LINUX_HABITS = { 'Mod+Shift+KeyC': 'copy in Linux terminals', 'Mod+Shift+KeyV': 'paste in Linux terminals', 'Mod+Shift+KeyT': 'a new tab in terminals and GTK apps', 'Mod+Shift+KeyN': 'a new window in terminals and GTK apps', 'Mod+Shift+KeyW': 'close tab in terminals and GTK apps', 'Mod+Shift+KeyF': 'find in many GTK apps' };

/**
 * Can `chord` be bound to `actionId`? os: 'mac' | 'linux' | 'win';
 * build: 'desktop' | 'web'; bindings: the current resolved map.
 * Returns { ok, level: null | 'warn' | 'block' | 'conflict', message,
 * conflictId }: 'block' cannot be used, 'conflict' can replace the other
 * action's binding, 'warn' is allowed with the message shown.
 */
export function validateChord(chord, { actionId, os, build, bindings }) {
  const action = actionById(actionId);
  const platform = platformOf(os);
  const parsed = parseChord(chord);
  if (!action) return { ok: false, level: 'block', message: 'Unknown action.' };
  if (!parsed) return { ok: false, level: 'block', message: 'Not a usable key combination.' };
  if (!isRebindable(action)) return { ok: false, level: 'block', message: `${action.label} is fixed.` };
  if (parsed.mods.includes('Meta')) return { ok: false, level: 'block', message: `The ${os === 'win' ? 'Windows' : 'Super'} key belongs to the system.` };
  const hasMain = parsed.mods.includes('Mod') || parsed.mods.includes('Ctrl') || parsed.mods.includes('Alt');
  if (!hasMain && !/^F([1-9]|1[0-2])$/.test(parsed.key) && !action.plainKeys) {
    return { ok: false, level: 'block', message: `${formatChord(chord, { mac: os === 'mac' })} would type into text fields - add ${os === 'mac' ? '⌘, ⌥ or ⌃' : 'Ctrl or Alt'}.` };
  }
  if (OS_RESERVED[os]?.includes(chord)) return { ok: false, level: 'block', message: `${formatChord(chord, { mac: os === 'mac' })} belongs to ${os === 'mac' ? 'macOS' : os === 'win' ? 'Windows' : 'the desktop'}: the app never sees it.` };
  if (build === 'web' && BROWSER_RESERVED.includes(chord)) return { ok: false, level: 'block', message: `${formatChord(chord, { mac: os === 'mac' })} belongs to the browser (tabs, windows, developer tools): the page cannot take it.` };
  for (const other of ACTIONS) {
    if (other.id === action.id) continue;
    if (build === 'web' && other.desktopOnly) continue;   // no menu in a browser: those chords are free there
    const taken = bindings[other.id] === chord || aliasesOf(other, platform).includes(chord);
    if (!taken) continue;
    // a menu accelerator fires whatever has focus; a fixed role cannot move
    const menuWide = build === 'desktop' && other.owner === 'menu';
    if (!menuWide && !scopesOverlap(action.scope, other.scope)) continue;
    if (!isRebindable(other) || aliasesOf(other, platform).includes(chord)) {
      return { ok: false, level: 'block', message: `${formatChord(chord, { mac: os === 'mac' })} is ${other.label} and cannot be changed.`, conflictId: other.id };
    }
    return { ok: false, level: 'conflict', message: `${formatChord(chord, { mac: os === 'mac' })} is ${other.label}.`, conflictId: other.id };
  }
  if (os === 'linux' && LINUX_HABITS[chord] && chord !== defaultChord(action, platform)) {
    return { ok: true, level: 'warn', message: `${formatChord(chord, { mac: false })} is ${LINUX_HABITS[chord]} - a slip there would ${action.label.toLowerCase()} here.` };
  }
  return { ok: true, level: null, message: '' };
}
