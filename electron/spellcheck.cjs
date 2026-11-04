// The spell checker's dictionaries on Windows and Linux, where Electron
// uses Hunspell: Chromium looks for `<sessionData>/Dictionaries/<language>-
// <version>.bdic` and, when a file is not there, DOWNLOADS it from Google's
// CDN (redirector.gvt1.com) - an outbound request nothing in the app
// declares. Jacarium ships the dictionaries instead (build/dictionaries at
// build time -> resources/dictionaries in the packaged app; the list and
// their sha256 are in spellcheck-dictionaries.json, fetched and checked by
// scripts/fetch-spellcheck-dictionaries.mjs) and puts them in place before
// the session exists, after checking each file's sha256 again. The download
// URL is then pointed at a file: URL that cannot be fetched, so a language
// that is not shipped fails locally instead of reaching out (Electron sets
// that URL once for every session; it is a no-op on macOS).
//
// macOS uses NSSpellChecker: nothing here runs there (setUp returns at
// once), nothing is copied and the mac build packages no dictionary.
//
// Every function but setUp() is plain Node (tests/electron-spellcheck-
// dictionaries.test.mjs runs them against temporary directories).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_FILE = path.join(__dirname, 'spellcheck-dictionaries.json');
// Platforms whose Electron spell checker uses Hunspell dictionaries
const DICTIONARY_PLATFORMS = new Set(['win32', 'linux']);
// A valid URL (Electron refuses an invalid one) that is never on the
// network: the file: loader of the browser process does not serve it, so a
// download attempt fails at once, locally.
const NO_DOWNLOAD_URL = 'file:///nonexistent/jacarium-spellcheck-dictionaries/';
const FALLBACK_LANGUAGE = 'en-US';

// What happened at start-up, for the log and for tests (status())
const state = {
  platform: process.platform,
  active: false,
  sourceDir: null,
  targetDir: null,
  downloadURL: null,
  installed: [],
  kept: [],
  skipped: [],
  missing: [],
  languages: [],
  wanted: [],
  downloads: [],
  initialized: [],
  failures: [],
  ready: false,
  readyPromise: null,
  readyTimer: null,
  copyError: null,
  setUpError: null,
  disabled: false,
};

function readManifest(file = MANIFEST_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The language codes the manifest ships dictionaries for. */
function shippedLanguages(manifest) {
  return (manifest.dictionaries || []).map((d) => d.language);
}

/**
 * The languages the checker should run with: the configured ones that are
 * shipped; en-US when none of them is (a language that is not shipped
 * would only make Electron try a download, which fails).
 */
function chooseLanguages(configured, shipped) {
  const available = new Set(shipped);
  const kept = (configured || []).filter((code) => available.has(code));
  if (kept.length) return kept;
  return available.has(FALLBACK_LANGUAGE) ? [FALLBACK_LANGUAGE] : shipped.slice(0, 1);
}

/** Where the shipped dictionaries are: next to the app's resources when packaged, build/dictionaries in a checkout. */
function dictionarySourceDir({ isPackaged, resourcesPath, repoRoot }) {
  return isPackaged ? path.join(resourcesPath, 'dictionaries') : path.join(repoRoot, 'build', 'dictionaries');
}

/**
 * Copy the manifest's dictionaries from sourceDir into targetDir (Chromium's
 * Dictionaries directory), each one only after its sha256 matched the
 * manifest: a source file that does not match is left out (and said so), a
 * target file that already matches is kept, any other target file - an
 * older download, a different version - is replaced. Returns what was done.
 */
function installDictionaries({ sourceDir, targetDir, manifest, log = () => {} }) {
  const result = { installed: [], kept: [], skipped: [], missing: [] };
  for (const entry of manifest.dictionaries || []) {
    const source = path.join(sourceDir, entry.file);
    const target = path.join(targetDir, entry.file);
    if (!fs.existsSync(source)) {
      result.missing.push(entry.file);
      continue;
    }
    let sourceHash;
    try { sourceHash = sha256File(source); } catch (error) {
      result.skipped.push(entry.file);
      log(`[Spellcheck] ${entry.file}: cannot read ${source} (${error.message})`);
      continue;
    }
    if (sourceHash !== entry.sha256) {
      result.skipped.push(entry.file);
      log(`[Spellcheck] ${entry.file}: sha256 ${sourceHash} is not the pinned ${entry.sha256} - not installed`);
      continue;
    }
    try {
      if (fs.existsSync(target) && sha256File(target) === entry.sha256) {
        result.kept.push(entry.file);
        continue;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      // written beside the target and renamed into place, so the checker
      // never opens a half-copied file
      const partial = path.join(targetDir, `.${entry.file}.${process.pid}.partial`);
      fs.copyFileSync(source, partial);
      fs.renameSync(partial, target);
      result.installed.push(entry.file);
    } catch (error) {
      result.skipped.push(entry.file);
      log(`[Spellcheck] ${entry.file}: could not be installed into ${targetDir} (${error.message})`);
    }
  }
  return result;
}

/**
 * The start-up sequence, before the first window: on Windows / Linux put the
 * shipped dictionaries into the profile's Dictionaries directory, create the
 * default session, point its dictionary download at the local file: URL,
 * and keep the languages to the shipped ones. `copy: false` (the profile
 * picker, whose userData is a throwaway directory) only sets the URL.
 */
function setUp({ app, session, log = console.log, copy = true, manifest = null, platform = process.platform, sourceDir = null }) {
  if (!DICTIONARY_PLATFORMS.has(platform)) return status();   // macOS: the system checker, nothing to do
  state.active = true;
  // Whatever goes wrong in the copy step is logged and never skips the URL
  // step below: a missing file means no dictionary for that language, not
  // a download.
  let data = null;
  if (copy) {
    try {
      data = manifest || readManifest();
      state.sourceDir = sourceDir || dictionarySourceDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: path.join(__dirname, '..') });
      state.targetDir = path.join(app.getPath('sessionData'), 'Dictionaries');
      const done = installDictionaries({ sourceDir: state.sourceDir, targetDir: state.targetDir, manifest: data, log });
      Object.assign(state, done);
      if (done.missing.length) {
        log(`[Spellcheck] not shipped in ${state.sourceDir}: ${done.missing.join(', ')} (node scripts/fetch-spellcheck-dictionaries.mjs fetches them for a checkout)`);
      }
      log(`[Spellcheck] dictionaries in ${state.targetDir}: ${done.installed.length} installed, ${done.kept.length} kept${done.skipped.length ? `, ${done.skipped.length} refused` : ''}`);
    } catch (error) {
      data = null;
      state.copyError = error.message;
      log(`[Spellcheck] the dictionaries were not installed (${error.message}) - the download is still pointed at the local URL`);
    }
  }
  // Creating the default session starts the dictionary initialisation
  // (asynchronous: the files above are opened on a worker thread, and only
  // then would a download be decided), so the URL set right here applies
  // to it - and, being process-wide, to every other session.
  const ses = session.defaultSession;
  ses.setSpellCheckerDictionaryDownloadURL(NO_DOWNLOAD_URL);
  state.downloadURL = NO_DOWNLOAD_URL;
  ses.on('spellcheck-dictionary-download-begin', (_event, languageCode) => {
    state.downloads.push(languageCode);
    log(`[Spellcheck] ${languageCode}: no dictionary shipped - Electron tried to fetch one, which fails locally (${NO_DOWNLOAD_URL})`);
  });
  ses.on('spellcheck-dictionary-download-failure', (_event, languageCode) => { state.failures.push(languageCode); settle(); });
  ses.on('spellcheck-dictionary-initialized', (_event, languageCode) => { state.initialized.push(languageCode); settle(); });
  if (copy && data) {
    try {
      const shipped = shippedLanguages(data);
      const configured = ses.getSpellCheckerLanguages();
      const chosen = chooseLanguages(configured, shipped);
      if (chosen.join(',') !== configured.join(',')) {
        ses.setSpellCheckerLanguages(chosen);
        // a new load of the dictionaries starts: what the first load reported
        // no longer says anything about the files the renderers will get
        state.initialized = [];
        state.failures = [];
        log(`[Spellcheck] languages ${configured.join(', ') || '(none)'} -> ${chosen.join(', ')} (shipped: ${shipped.join(', ')})`);
      }
      state.languages = ses.getSpellCheckerLanguages();
    } catch (error) {
      log(`[Spellcheck] languages not set (${error.message})`);
    }
  }
  state.wanted = copy ? state.languages.slice() : [];
  state.readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  state.readyTimer = setTimeout(() => { if (resolveReady) log(`[Spellcheck] still loading after ${READY_TIMEOUT_MS} ms (initialized: ${state.initialized.join(', ') || 'none'}) - not waiting any longer`); settle(true); }, READY_TIMEOUT_MS);
  if (typeof state.readyTimer.unref === 'function') state.readyTimer.unref();
  settle();
  return status();
}

// The dictionaries are loaded on a worker thread, and Chromium hands a
// loaded dictionary to the renderers that exist at that moment - skipping a
// renderer whose process is still launching (SpellcheckService::
// InitForAllRenderers checks the process handle), which then never gets it:
// a window created in the same tick as the session has no spell checking
// for the language that was just loaded. So the first window waits for
// 'spellcheck-dictionary-initialized' of every language in use (ready()),
// with a cap so a broken file can never hold the window back.
const READY_TIMEOUT_MS = 3000;
let resolveReady = null;
function settle(force = false) {
  if (!resolveReady) return;
  const reported = new Set([...state.initialized, ...state.failures]);
  if (!force && state.wanted.some((code) => !reported.has(code))) return;
  clearTimeout(state.readyTimer);
  const resolve = resolveReady;
  resolveReady = null;
  state.ready = true;
  resolve({ initialized: state.initialized.slice(), failures: state.failures.slice(), timedOut: force });
}

/**
 * What main.cjs runs when setUp() itself threw: nothing may end in
 * Electron's default (a dictionary fetched from Google's CDN), so the local
 * download URL is set once more and, when even that fails, the checker is
 * turned off for the session. A failure means no spell checking, never a
 * download.
 */
function failClosed({ session, log = console.log, error = null, platform = process.platform }) {
  if (!DICTIONARY_PLATFORMS.has(platform)) return status();
  state.active = true;
  state.setUpError = error ? error.message : 'unknown';
  log(`[Spellcheck] not set up (${state.setUpError}) - failing closed`);
  let ses = null;
  try {
    ses = session.defaultSession;
    ses.setSpellCheckerDictionaryDownloadURL(NO_DOWNLOAD_URL);
    state.downloadURL = NO_DOWNLOAD_URL;
    log(`[Spellcheck] dictionary download pointed at ${NO_DOWNLOAD_URL}`);
  } catch (urlError) {
    log(`[Spellcheck] the download URL could not be set (${urlError.message}) - turning the spell checker off for this session`);
    try {
      ses = ses || session.defaultSession;
      ses.setSpellCheckerEnabled(false);
      state.disabled = true;
      log('[Spellcheck] spell checker off');
    } catch (offError) {
      log(`[Spellcheck] the spell checker could not be turned off either (${offError.message})`);
    }
  }
  settle(true);
  return status();
}

/** Resolves once every language in use has its dictionary loaded (or failed, or the cap passed); at once where nothing was set up. */
function ready() {
  return state.readyPromise || Promise.resolve({ initialized: [], failures: [], timedOut: false });
}

function status() {
  const { readyPromise, readyTimer, ...plain } = state;
  return plain;
}

// ---------------------------------------------------------------------------
// The right-click menu's spelling items. The renderer shows its own menu
// (TextSelectionMenu) and, in the desktop app, lets the contextmenu event
// through, so Chromium reports the word under the pointer and its
// suggestions to this process ('context-menu' on the webContents). They go
// back to the renderer over one narrow channel: the word and at most
// MAX_SUGGESTIONS suggestions, each at most MAX_WORD_LENGTH characters. The
// renderer replaces the word itself (a CodeMirror transaction - Yjs and undo
// see a normal edit); "Add to dictionary" comes back over IPC and is only
// honoured for the word the last menu of that webContents was about.
// ---------------------------------------------------------------------------
const MAX_WORD_LENGTH = 64;
const MAX_SUGGESTIONS = 6;
/** The most words one spellcheck:import-words call takes (src/utils/customWords.js caps at the same). */
const MAX_IMPORT_WORDS = 10000;
const CONTEXT_MENU_CHANNEL = 'editor-context-menu';
// the last menu's word per webContents (what addWord may be asked for)
const lastMenuWord = new WeakMap();

/** A string of 1..MAX_WORD_LENGTH characters without line breaks or control characters (a suggestion may be two words, "sen tense"). */
function isWord(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WORD_LENGTH && !/[\u0000-\u001f\u007f]/.test(value) && value.trim() === value;
}

/** What goes INTO the dictionary: a word with no whitespace inside either (Chromium's custom dictionary takes single words). */
function isDictionaryWord(value) {
  return isWord(value) && !/[\s\u0080-\u009f]/.test(value);
}

/**
 * What the renderer gets from Chromium's context-menu params: null when the
 * click was not in an editable field or no word was flagged; else the word,
 * its first MAX_SUGGESTIONS valid suggestions (deduplicated) and the pointer
 * position in the page.
 */
function sanitizeMenuParams(params) {
  if (!params || typeof params !== 'object' || !params.isEditable) return null;
  const word = params.misspelledWord;
  if (!isWord(word)) return null;
  const seen = new Set();
  const suggestions = [];
  for (const candidate of Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : []) {
    if (!isWord(candidate) || candidate === word || seen.has(candidate)) continue;
    seen.add(candidate);
    suggestions.push(candidate);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  const x = Number.isFinite(params.x) ? Math.round(params.x) : 0;
  const y = Number.isFinite(params.y) ? Math.round(params.y) : 0;
  return { misspelledWord: word, suggestions, x, y };
}

/** Watch a webContents' context-menu events and forward the spelling part to its renderer. */
function watchContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    const safe = sanitizeMenuParams(params);
    lastMenuWord.set(webContents, safe ? safe.misspelledWord : null);
    if (!safe) return;
    try { webContents.send(CONTEXT_MENU_CHANNEL, safe); } catch { /* the window is going */ }
  });
}

/** The languages the renderer may offer: the shipped ones (code + label) on Hunspell platforms, none on macOS. */
function languageChoices(manifest = null, platform = process.platform) {
  if (!DICTIONARY_PLATFORMS.has(platform)) return [];
  const data = manifest || readManifest();
  return (data.dictionaries || []).map((d) => ({ code: d.language, label: d.label }));
}

/**
 * The IPC handlers behind Settings > General > Editor and the menu's "Add to
 * dictionary": each validates what the renderer sends before the session
 * hears of it. `session` is Electron's session module (defaultSession is
 * read when a call comes, never earlier).
 */
function installIpc({ ipcMain, session, log = console.log, platform = process.platform, manifest = null }) {
  const ses = () => session.defaultSession;
  ipcMain.handle('spellcheck:add-word', (event, word) => {
    if (!isDictionaryWord(word)) return { ok: false, reason: 'not a word' };
    if (lastMenuWord.get(event.sender) !== word) return { ok: false, reason: 'not the word of the last menu' };
    const ok = ses().addWordToSpellCheckerDictionary(word);
    log(`[Spellcheck] "${word}" ${ok ? 'added to' : 'not added to'} the custom dictionary`);
    return { ok: !!ok };
  });
  ipcMain.handle('spellcheck:list-words', async () => {
    const words = await ses().listWordsInSpellCheckerDictionary();
    return (Array.isArray(words) ? words : []).filter(isWord).sort((a, b) => a.localeCompare(b));
  });
  // Settings > Editor's "Import custom words" and the database import: a
  // list of words (the renderer read the file; only words arrive), merged
  // into the dictionary - each checked with isWord, the ones already there
  // left alone, nothing removed; at most MAX_IMPORT_WORDS per call.
  ipcMain.handle('spellcheck:import-words', async (_event, words) => {
    if (!Array.isArray(words)) return { ok: false, reason: 'not a list of words' };
    if (words.length > MAX_IMPORT_WORDS) return { ok: false, reason: `more than ${MAX_IMPORT_WORDS} words` };
    const current = await ses().listWordsInSpellCheckerDictionary();
    const have = new Set(Array.isArray(current) ? current : []);
    const taken = [];
    let existing = 0, skipped = 0;
    for (const word of words) {
      if (!isDictionaryWord(word)) { skipped += 1; continue; }
      if (have.has(word)) { existing += 1; continue; }
      if (ses().addWordToSpellCheckerDictionary(word)) { taken.push(word); have.add(word); } else skipped += 1;
    }
    log(`[Spellcheck] import: ${taken.length} added, ${existing} already there, ${skipped} skipped`);
    return { ok: true, added: taken.length, existing, skipped, words: taken };
  });
  ipcMain.handle('spellcheck:remove-word', async (_event, word) => {
    if (!isWord(word)) return { ok: false, reason: 'not a word' };
    const words = await ses().listWordsInSpellCheckerDictionary();
    if (!Array.isArray(words) || !words.includes(word)) return { ok: false, reason: 'not in the custom dictionary' };
    const ok = ses().removeWordFromSpellCheckerDictionary(word);
    return { ok: !!ok };
  });
  ipcMain.handle('spellcheck:languages', () => {
    const native = !DICTIONARY_PLATFORMS.has(platform);
    let selected = [];
    try { selected = native ? [] : ses().getSpellCheckerLanguages(); } catch { selected = []; }
    return { native, platform, available: languageChoices(manifest, platform), selected, enabled: ses().isSpellCheckerEnabled() };
  });
  ipcMain.handle('spellcheck:set-languages', (_event, codes) => {
    if (!DICTIONARY_PLATFORMS.has(platform)) return { ok: false, reason: 'the system spell checker chooses the languages' };
    const allowed = new Set(languageChoices(manifest, platform).map((c) => c.code));
    const chosen = Array.isArray(codes) ? [...new Set(codes.filter((c) => typeof c === 'string' && allowed.has(c)))] : [];
    if (!chosen.length) return { ok: false, reason: 'choose at least one shipped language' };
    try {
      ses().setSpellCheckerLanguages(chosen);
      state.languages = chosen;
      log(`[Spellcheck] languages -> ${chosen.join(', ')}`);
      return { ok: true, selected: chosen };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });
}

module.exports = {
  MAX_WORD_LENGTH,
  MAX_SUGGESTIONS,
  MAX_IMPORT_WORDS,
  isDictionaryWord,
  CONTEXT_MENU_CHANNEL,
  isWord,
  sanitizeMenuParams,
  watchContextMenu,
  languageChoices,
  installIpc,
  MANIFEST_FILE,
  DICTIONARY_PLATFORMS,
  NO_DOWNLOAD_URL,
  FALLBACK_LANGUAGE,
  readManifest,
  sha256File,
  shippedLanguages,
  chooseLanguages,
  dictionarySourceDir,
  installDictionaries,
  setUp,
  failClosed,
  ready,
  status,
  READY_TIMEOUT_MS,
};
