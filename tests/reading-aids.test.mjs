#!/usr/bin/env node
/**
 * The reading aids (Settings > Accessibility; src/utils/readingAids.js, the
 * app surface and the document surface of
 * src/components/common/ReadingAidsSurface.jsx, the ruler's geometry):
 *
 *  1. the model: defaults, normalisation of untrusted input, the scope of
 *     each option (everywhere / reading text / documents only), storage of
 *     the differences only, the change event, reset; the variables and
 *     classes per scope - none for the defaults; applyAppReadingAids() on an
 *     element; the ruler's band geometry; zen mode;
 *  1a. the shortcuts;
 *  1b. the colour blocks re-measured from the stylesheet (high contrast
 *      7:1, the palettes 4.5:1 and Okabe-Ito hues, the status colours apart);
 *  2. jsdom: the Accessibility panel in its three groups, a change reaching
 *     <html> and the document surface, Reset, zen; hidden images on a
 *     preview DOM; the wiring in the sources (no active-line marker in the
 *     editor, the shell's hooks, the frame bridge, the stylesheet's resets).
 *
 * Needs esbuild, jsdom and fake-indexeddb for part 2. Run: node tests/reading-aids.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 500) : ''}`); if (!ok) failed++; };
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RA = await import(path.join(REPO, 'src/utils/readingAids.js'));

// ---- 1. the model
{
  const d = RA.DEFAULT_READING_AIDS;
  check('1. the defaults are all off: spacings / width 0, left, the default font, the ruler off at 1 line / highlight, every toggle false, no palette, full saturation', d.lineHeight === 0 && d.letterSpacing === 0 && d.wordSpacing === 0 && d.paragraphSpacing === 0 && d.lineWidth === 0 && d.textAlign === 'left' && d.font === 'default' && !d.ruler && d.rulerLines === 1 && d.rulerMode === 'highlight' && d.textScale === 100 && d.scaleChrome === false && !d.hideImages && !d.highlightLinks && !d.highContrast && d.colorVision === 'none' && d.saturation === 100 && !d.greyscale && !('dimOthers' in d));
  const n = RA.normalizeReadingAids({ lineHeight: '2', letterSpacing: 9, wordSpacing: -1, paragraphSpacing: 7, lineWidth: 65, textAlign: 'center', font: 'comic', ruler: 'yes', rulerLines: 4, rulerMode: 'glow', textScale: 137, scaleChrome: 'yes', hideImages: true, colorVision: 'x', saturation: 3, greyscale: 1, dimOthers: true, bogus: 1 });
  check('1. normalisation: numbers from strings, clamped to the bounds, a value off its list falls back (ruler lines 1, highlight), a non-boolean toggle falls back, unknown and retired keys (dimOthers) are dropped', n.lineHeight === 2 && n.letterSpacing === RA.LETTER_SPACING_MAX && n.wordSpacing === 0 && n.paragraphSpacing === 0 && n.lineWidth === 0 && n.textAlign === 'left' && n.font === 'default' && n.ruler === false && n.rulerLines === 1 && n.rulerMode === 'highlight' && n.textScale === 137 && n.scaleChrome === false && n.hideImages === true && n.colorVision === 'none' && n.saturation === RA.SATURATION_MIN && n.greyscale === false && !('bogus' in n) && !('dimOthers' in n), JSON.stringify(n));
  check('1. junk input gives the defaults', JSON.stringify(RA.normalizeReadingAids('x')) === JSON.stringify(RA.normalizeReadingAids(null)) && RA.isDefaultReadingAids(RA.normalizeReadingAids(undefined)));
  check('1. every option has a scope: colour, links and images everywhere; the font, spacing, line height, paragraph spacing and the ruler for reading text; the column and the alignment for reading text too (long-form text everywhere)', Object.keys(d).every((k) => RA.OPTION_SCOPE[k]) && ['highContrast', 'colorVision', 'saturation', 'greyscale', 'highlightLinks', 'hideImages', 'reduceMotion'].every((k) => RA.OPTION_SCOPE[k] === 'app') && ['font', 'letterSpacing', 'wordSpacing', 'lineHeight', 'paragraphSpacing', 'ruler', 'rulerLines', 'rulerMode', 'textScale'].every((k) => RA.OPTION_SCOPE[k] === 'reading') && RA.OPTION_SCOPE.scaleChrome === 'app' && ['lineWidth', 'textAlign'].every((k) => RA.OPTION_SCOPE[k] === 'reading') && RA.SCOPE_LABELS.app && RA.SCOPE_LABELS.reading && !RA.SCOPE_LABELS.documents);
  check('1. the vars for the defaults: none in any scope; the classes: ra-app for the app surface, ra-surface for the document surface', ['app', 'documents', 'all'].every((sc) => Object.keys(RA.readingAidsVars(d, sc)).length === 0) && RA.readingAidsClasses(d, 'app').join() === 'ra-app' && RA.readingAidsClasses(d, 'documents').join() === 'ra-surface');
  const all = { lineHeight: 2, letterSpacing: 0.05, wordSpacing: 0.2, paragraphSpacing: 1.5, lineWidth: 70, textAlign: 'justify-hyphens', font: 'opendyslexic', saturation: 40, ruler: true, rulerLines: 3 };
  const app = RA.readingAidsVars(all, 'app');
  const docs = RA.readingAidsVars(all, 'documents');
  check('1. the app scope carries the reading-text and colour vars (line height, em spacings, paragraph spacing, the font stack, a saturate() filter, the ruler lines) and the column and the alignment (reading-text options), with the gates ra-line / ra-para / ra-width / ra-justify among the classes', app['--ra-line-height'] === '2' && app['--ra-letter-spacing'] === '0.05em' && app['--ra-word-spacing'] === '0.2em' && app['--ra-paragraph-spacing'] === '1.5em' && /OpenDyslexic/.test(app['--ra-font-family']) && app['--ra-filter'] === 'saturate(40%)' && app['--ra-ruler-lines'] === '3' && app['--ra-max-width'] === '70ch' && app['--ra-text-align'] === 'justify' && app['--ra-hyphens'] === 'auto' && ['ra-line', 'ra-para', 'ra-width', 'ra-justify'].every((c) => RA.readingAidsClasses(all, 'app').includes(c)) && RA.readingAidsClasses({ lineHeight: 2 }, 'app').join() === 'ra-app,ra-line', JSON.stringify(app));
  check('1. the documents scope carries no var of its own now (the surface is the ra-surface class; the column and the alignment come from <html>)', Object.keys(docs).length === 0, JSON.stringify(docs));
  check('1. greyscale wins over saturation; plain justify has no hyphens', RA.readingAidsVars({ greyscale: true, saturation: 40 }, 'app')['--ra-filter'] === 'grayscale(1)' && !('--ra-hyphens' in RA.readingAidsVars({ textAlign: 'justify' }, 'documents')));
  check('1. the app classes: the ruler with its mode, hidden images, links, high contrast, the colour-vision palette', RA.readingAidsClasses({ ruler: true, rulerMode: 'mask', hideImages: true, highlightLinks: true, highContrast: true, colorVision: 'deuteranopia' }, 'app').join() === 'ra-app,ra-ruler,ra-ruler-mask,ra-hide-images,ra-links,ra-high-contrast,ra-cv-deuteranopia' && RA.readingAidsClasses({ ruler: true }, 'app').includes('ra-ruler-highlight'));
  check('1. text size: any value from 90 to 200 % is kept (an older stop such as 112.5 stays valid), clamped at the ends, one decimal; the tick marks are 100 / 125 / 150 / 175 / 200; 150 gives --ra-text-scale 1.5 in the app scope; the interface class only with the toggle and a scale away from 100', RA.TEXT_SCALES.join() === '100,125,150,175,200' && RA.TEXT_SCALE_MIN === 90 && RA.TEXT_SCALE_MAX === 200 && RA.TEXT_SCALE_STEP === 5 && RA.normalizeReadingAids({ textScale: 112.5 }).textScale === 112.5 && RA.normalizeReadingAids({ textScale: 130 }).textScale === 130 && RA.normalizeReadingAids({ textScale: 117.25 }).textScale === 117.3 && RA.normalizeReadingAids({ textScale: 300 }).textScale === 200 && RA.normalizeReadingAids({ textScale: 10 }).textScale === 90 && RA.normalizeReadingAids({ textScale: 'x' }).textScale === 100 && RA.normalizeReadingAids({ textScale: '175' }).textScale === 175 && RA.readingAidsVars({ textScale: 150 }, 'app')['--ra-text-scale'] === '1.5' && RA.readingAidsVars({ textScale: 115 }, 'app')['--ra-text-scale'] === '1.15' && !('--ra-text-scale' in RA.readingAidsVars({ textScale: 100 }, 'app')) && RA.readingAidsClasses({ textScale: 150, scaleChrome: true }, 'app').includes('ra-scale-chrome') && !RA.readingAidsClasses({ textScale: 100, scaleChrome: true }, 'app').includes('ra-scale-chrome'));
  check('1. snapTextScale puts new slider input on the 5 % grid inside the range; stepTextScale moves 5 % on that grid from any value and stops at the ends', RA.snapTextScale(113) === 115 && RA.snapTextScale(112.5) === 115 && RA.snapTextScale(91) === 90 && RA.snapTextScale(199) === 200 && RA.snapTextScale(500) === 200 && RA.snapTextScale('abc') === 100 && RA.stepTextScale({ textScale: 100 }, 1) === 105 && RA.stepTextScale({ textScale: 105 }, -1) === 100 && RA.stepTextScale({ textScale: 112.5 }, 1) === 120 && RA.stepTextScale({ textScale: 112.5 }, -1) === 110 && RA.stepTextScale({ textScale: 200 }, 1) === 200 && RA.stepTextScale({ textScale: 90 }, -1) === 90 && RA.stepTextScale({}, -1) === 95);
  // storage: a fake localStorage
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  RA.saveReadingAids({ ruler: true, lineHeight: 1.8 }, store);
  check('1. saveReadingAids stores only the differences from the defaults under the key', JSON.stringify(JSON.parse(mem.get(RA.READING_AIDS_KEY))) === JSON.stringify({ lineHeight: 1.8, ruler: true }) && RA.loadReadingAids(store).ruler === true && RA.loadReadingAids(store).lineHeight === 1.8 && RA.loadReadingAids(store).font === 'default');
  RA.saveReadingAids({ ruler: false, lineHeight: 0 }, store);
  check('1. ...and removes the key when everything is back at the defaults; reset does the same', !mem.has(RA.READING_AIDS_KEY) && (RA.saveReadingAids({ greyscale: true }, store), RA.resetReadingAids(store), !mem.has(RA.READING_AIDS_KEY)));
  check('1. a broken stored value gives the defaults; a stored dimOthers from the first version is dropped', (mem.set(RA.READING_AIDS_KEY, '{nope'), RA.isDefaultReadingAids(RA.loadReadingAids(store))) && (mem.set(RA.READING_AIDS_KEY, '{"dimOthers":true,"ruler":true}'), RA.loadReadingAids(store).ruler === true && !('dimOthers' in RA.loadReadingAids(store))));
  check('1. the key and the events are named (per device, like the editor\'s spell checking)', RA.READING_AIDS_KEY === 'documentsReadingAids' && RA.READING_AIDS_CHANGED_EVENT === 'documentsReadingAidsChanged' && RA.ZEN_CHANGED_EVENT === 'documentsZenChanged' && /localStorage/.test(read('src/utils/readingAids.js')) && !/\/api\//.test(read('src/utils/readingAids.js')));
  check('1. zen mode is a mode in memory: off, toggles, not part of the stored settings', RA.zenMode.on === false && (RA.zenMode.toggle(), RA.zenMode.on === true) && (RA.zenMode.set(false), RA.zenMode.on === false) && !('zen' in RA.DEFAULT_READING_AIDS));
  check('1. the fonts offered are bundled @fontsource packages (OFL): Atkinson Hyperlegible, Lexend, OpenDyslexic', ['atkinson', 'lexend', 'opendyslexic'].every((k) => RA.READING_FONTS[k] && /@fontsource\//.test(RA.READING_FONTS[k].pkg)));
  const fonts = read('src/utils/readingFonts.js');
  const pkg = JSON.parse(read('package.json'));
  check('1. each font is a devDependency (bundled at build time, like Red Hat Text), OFL-1.1 in the lock, and src/utils/readingFonts.js imports its latin 400 and 700 faces lazily; the app surface loads the chosen font', ['atkinson', 'lexend', 'opendyslexic'].every((k) => { const name = RA.READING_FONTS[k].pkg; const lock = JSON.parse(read('package-lock.json')).packages['node_modules/' + name]; return pkg.devDependencies[name] && !pkg.dependencies[name] && lock && lock.license === 'OFL-1.1' && new RegExp("import\\('" + name + "/latin-400\\.css'\\)").test(fonts) && new RegExp("import\\('" + name + "/latin-700\\.css'\\)").test(fonts); }) && /ensureReadingFont\(settings\.font\)/.test(read('src/components/common/ReadingAidsSurface.jsx')));
  const about = read('src/components/common/modals/settings/AboutSettings.jsx');
  check('1. the fonts are credited in About (OFL) and in the README\'s Licence section', ['Atkinson Hyperlegible', 'Lexend', 'OpenDyslexic'].every((n) => new RegExp("\\{ name: '" + n + "', what: 'reading font \\(Settings > Accessibility\\)', url: 'https?://[^']+', \\.\\.\\.OFL \\}").test(about) && read('README.md').includes(n)));
  // the code font: Default (Red Hat Mono) or Atkinson Hyperlegible Mono (bundled, OFL); OpenDyslexic Mono has no maintained package
  check('1. the code fonts offered: Default (the app\'s Red Hat Mono) and Atkinson Hyperlegible Mono, a bundled @fontsource package (OFL) whose stack falls back to Red Hat Mono; no OpenDyslexic Mono (no maintained package on the registry)',
    Object.keys(RA.CODE_FONTS).join() === 'default,atkinsonMono' && RA.CODE_FONTS.default.family === null && /^"Atkinson Hyperlegible Mono", "Red Hat Mono", Consolas, monospace$/.test(RA.CODE_FONTS.atkinsonMono.family) && RA.CODE_FONTS.atkinsonMono.pkg === '@fontsource/atkinson-hyperlegible-mono');
  check('1. the code font is a reading-text option, Default by default; junk falls back to Default; the var --ra-code-font-family carries the stack in the app scope when chosen, nothing when Default',
    d.codeFont === 'default' && RA.OPTION_SCOPE.codeFont === 'reading' && RA.normalizeReadingAids({ codeFont: 'comic' }).codeFont === 'default' && RA.normalizeReadingAids({ codeFont: 'atkinsonMono' }).codeFont === 'atkinsonMono'
    && RA.readingAidsVars({ codeFont: 'atkinsonMono' }, 'app')['--ra-code-font-family'] === RA.CODE_FONTS.atkinsonMono.family && !('--ra-code-font-family' in RA.readingAidsVars({ codeFont: 'default' }, 'app')) && !('--ra-code-font-family' in RA.readingAidsVars({ codeFont: 'atkinsonMono' }, 'documents')));
  check('1. the code font package is a devDependency, OFL-1.1 in the lock, its latin 400 / 700 / 400-italic faces loaded lazily (readingFonts.js) and inlined for the frame (readingFontFaces.js); the app surface loads the chosen code font', (() => {
    const name = RA.CODE_FONTS.atkinsonMono.pkg; const lock = JSON.parse(read('package-lock.json')).packages['node_modules/' + name];
    return pkg.devDependencies[name] && !(pkg.dependencies || {})[name] && lock && lock.license === 'OFL-1.1' && lock.dev === true
      && new RegExp("atkinsonMono: \\(\\) => Promise\\.all\\(\\[\\s*import\\('" + name + "/latin-400\\.css'\\),\\s*import\\('" + name + "/latin-700\\.css'\\),\\s*import\\('" + name + "/latin-400-italic\\.css'\\),").test(fonts)
      && /atkinsonMono: \(\) => Promise\.all\(\[\s*import\('@fontsource\/atkinson-hyperlegible-mono\/files\/atkinson-hyperlegible-mono-latin-400-normal\.woff2\?inline'\)\.then\(\(m\) => \['Atkinson Hyperlegible Mono', 400, 'normal', m\.default\]\)/.test(read('src/utils/readingFontFaces.js'))
      && /ensureReadingFont\(settings\.codeFont\)/.test(read('src/components/common/ReadingAidsSurface.jsx'));
  })());
  check('1. the stylesheet routes it through one token: html.ra-app\'s --font-mono reads --ra-code-font-family with today\'s Red Hat Mono stack as the fallback (so code blocks, inline code, the editor\'s code and gutter, logs, kbd and the report\'s monospace parts follow); the code parts keep letter-spacing 0',
    /html\.ra-app \{[^}]*--font-mono: var\(--ra-code-font-family, "Red Hat Mono", Consolas, monospace\);/.test(read('src/index.css')) && /\.sc-editor-cm \.cm-gutters[^{]*\) \{ letter-spacing: 0; word-spacing: normal; \}/.test(read('src/index.css')));
  check('1. the Diagnostics page sends the code font\'s faces to the frame with the reading font\'s', /Promise\.all\(\[readingFontFaceCss\(readingAids\.font\), readingFontFaceCss\(readingAids\.codeFont\)\]\)/.test(read('src/components/DiagnosticsPage.jsx')) && /\[readingAids\.font, readingAids\.codeFont\]/.test(read('src/components/DiagnosticsPage.jsx')));
  check('1. Atkinson Hyperlegible Mono is credited in About as the code font (OFL) and in the README', /\{ name: 'Atkinson Hyperlegible Mono', what: 'code font \(Settings > Accessibility\)', url: 'https?:\/\/[^']+', \.\.\.OFL \}/.test(about) && read('README.md').includes('Atkinson Hyperlegible Mono'));
  // the ruler's geometry
  const b1 = RA.rulerBand({ lineTop: 100, lineHeight: 24, lines: 1, areaTop: 0, areaBottom: 500 });
  const b3 = RA.rulerBand({ lineTop: 100, lineHeight: 24, lines: 3, areaTop: 0, areaBottom: 500 });
  const b5 = RA.rulerBand({ lineTop: 100, lineHeight: 24, lines: 5, areaTop: 0, areaBottom: 500 });
  check('1. the ruler band: one line is the line box itself; 3 and 5 lines are centred on it, line-height tall each', b1.top === 100 && b1.height === 24 && b3.top === 76 && b3.height === 72 && b5.top === 52 && b5.height === 120, JSON.stringify([b1, b3, b5]));
  check('1. ...a bad line count falls back to one; a line outside the area gives no band; a bad line height none', RA.rulerBand({ lineTop: 100, lineHeight: 24, lines: 4 }).height === 24 && RA.rulerBand({ lineTop: 600, lineHeight: 24, lines: 1, areaTop: 0, areaBottom: 500 }) === null && RA.rulerBand({ lineTop: 10, lineHeight: 0 }) === null);
  check('1. snapToLine lands on a line boundary of the reference line, never between lines', RA.snapToLine(130, 100, 24) === 124 && RA.snapToLine(100, 100, 24) === 100 && RA.snapToLine(99, 100, 24) === 76);
}

// ---- 1a. the shortcuts
{
  const reg = await import(path.join(REPO, 'src/shortcuts/registry.js'));
  const ids = ['reading.zen', 'reading.ruler', 'reading.highContrast', 'reading.greyscale', 'reading.hideImages', 'reading.highlightLinks'];
  const acts = ids.map((id) => reg.actionById(id));
  check('1a. six Reading actions in the registry (zen, ruler, high contrast, greyscale, hide images, highlighted links), renderer-owned, global (zen and the aids work on every page), in a Reading group', acts.every((a) => a && a.group === 'reading' && a.scope === 'global' && a.owner === 'renderer') && reg.GROUPS.some((g) => g.id === 'reading' && g.label === 'Reading'));
  const sizes = ['reading.textLarger', 'reading.textSmaller', 'reading.textReset'].map((id) => reg.actionById(id));
  check('1a. three text-size actions (increase, decrease, reset), everywhere, unassigned (the zoom owns Mod+Equal / Minus / Digit0), and the shell steps the stops on them', sizes.every((a) => a && a.group === 'reading' && a.scope === 'global' && a.owner === 'renderer' && a.defaults.mac === null && a.defaults.other === null) && /useShortcut\('reading\.textLarger', \(\) => \{ saveReadingAids\(\{ textScale: stepTextScale\(loadReadingAids\(\), 1\) \}\)/.test(read('src/components/JQLBuilder.jsx')) && /useShortcut\('reading\.textReset', \(\) => \{ saveReadingAids\(\{ textScale: 100 \}\)/.test(read('src/components/JQLBuilder.jsx')));
  check('1a. zen mode has Mod+Shift+E (free of the browser, the OS and the registry on every platform); the others are unassigned', acts[0].defaults.mac === 'Mod+Shift+KeyE' && acts[0].defaults.other === 'Mod+Shift+KeyE' && acts.slice(1).every((a) => a.defaults.mac === null && a.defaults.other === null) && ['mac', 'linux', 'win'].every((os) => ['desktop', 'web'].every((build) => reg.validateChord('Mod+Shift+KeyE', { actionId: 'reading.zen', os, build, bindings: reg.resolveBindings({}, { os, build }) }).ok)));
  const page_ = read('src/components/DocumentsPage.jsx');
  const shell_ = read('src/components/JQLBuilder.jsx');
  check('1a. the shell (every page) subscribes to each action (zen toggles the mode, the others flip their setting), the Documents page no longer does, and the Zen label in the status corner (ZenBadge) names the chords - no footer bar on either', ids.every((id) => shell_.includes(`useShortcut('${id}'`)) && !ids.some((id) => page_.includes(`useShortcut('${id}'`)) && /saveReadingAids\(\{ \[key\]: !loadReadingAids\(\)\[key\] \}\)/.test(shell_) && /useShortcutLabel\('reading\.zen'\)/.test(read('src/components/common/ZenBadge.jsx')) && /Zen mode: Esc\$\{leave \? ` or \$\{leave\}` : ''\} to leave/.test(read('src/components/common/ZenBadge.jsx')) && !/zen-hint/.test(page_) && !/zen-hint/.test(shell_) && /<ZenBadge \/>/.test(read('src/components/common/StatusCorner.jsx')));
  check('1a. the command palette has /zen (into zen mode on the page you are on; out of it when on - no detour to Documents)', /command: '\/zen'/.test(read('src/components/CommandPalette.jsx')) && /action: \(\) => \{\s*zenMode\.toggle\(\);\s*onClose\(\);/.test(read('src/components/CommandPalette.jsx')) && !/onNavigate\('documents'\);\s*zenMode\.toggle/.test(read('src/components/CommandPalette.jsx')));
}

// ---- 1b. the colour blocks, re-measured from the stylesheet (src/utils/customThemes.js contrastRatio)
{
  const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));
  const css = read('src/index.css');
  const block = (selector) => { const i = css.indexOf(`\n${selector} {`); if (i < 0) return null; const body = css.slice(i, css.indexOf('\n}', i)); return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+): ([^;]+);/g)].map((m) => [m[1], m[2].trim()])); };
  const CODE = ['keyword', 'string', 'number', 'comment', 'title', 'attr', 'builtin', 'variable', 'meta'];
  for (const [selector, mode] of [['html.ra-high-contrast body', 'light'], ['html.dark.ra-high-contrast body', 'dark']]) {
    const t = block(selector);
    const on = (bg) => ['--os-text-primary', '--os-text-secondary', '--os-text-muted', '--md-text', '--md-quote-text', '--link', '--md-link', '--os-blue', '--os-status-success', '--color-status-warning', '--color-status-danger', '--chart-good', '--chart-warn', '--chart-bad', '--rail-badge', '--brand-accent', '--btn-danger-fg', '--btn-success-text', '--btn-warning-text'].map((k) => [k, ct.contrastRatio(t[k], t[bg])]);
    const ratios = t ? Object.fromEntries([
      ...on('--os-card'), ...on('--os-canvas').map(([k, r]) => [k + '@canvas', r]), ...on('--os-modal').map(([k, r]) => [k + '@modal', r]),
      ['rail text', ct.contrastRatio(t['--os-rail-text'], t['--os-rail'])], ['rail active text', ct.contrastRatio(t['--os-rail-text-active'], t['--os-rail-active'])], ['rail tooltip', ct.contrastRatio(t['--os-rail-tooltip-text'], t['--os-rail-tooltip'])],
      ['code text', ct.contrastRatio(t['--md-code-text'], t['--md-code-bg'])], ...CODE.map((k) => ['code-' + k, ct.contrastRatio(t[`--os-code-${k}`], t['--os-code-bg'])]),
      ['terminal text', ct.contrastRatio(t['--os-terminal-text'], t['--os-terminal-bg'])], ['terminal muted', ct.contrastRatio(t['--os-terminal-muted'], t['--os-terminal-bg'])],
      ['primary button', ct.contrastRatio(t['--btn-primary-fg'], t['--btn-primary-bg'])], ['secondary button', ct.contrastRatio(t['--btn-secondary-fg'], t['--btn-secondary-bg'])], ['danger solid', ct.contrastRatio(t['--btn-danger-solid-fg'], t['--btn-danger-solid-bg'])], ['success button', ct.contrastRatio(t['--btn-success-fg'], t['--btn-success-bg'])], ['warning button', ct.contrastRatio(t['--btn-warning-fg'], t['--btn-warning-bg'])], ['brand button', ct.contrastRatio(t['--btn-brand-fg'], t['--btn-brand-bg'])],
      ['chat bubble', ct.contrastRatio(t['--chat-user-text'], t['--chat-user-bg'])], ['chat link', ct.contrastRatio(t['--chat-link'], t['--chat-user-bg'])],
      ['input text', ct.contrastRatio(t['--os-text-primary'], t['--os-input-bg'])], ['border', ct.contrastRatio(t['--os-border'], t['--os-card'])],
    ]) : {};
    const low = Object.entries(ratios).filter(([, r]) => !(r >= 7));
    check(`1b. high contrast (${mode}), declared on <body> under html${mode === 'dark' ? '.dark' : ''}.ra-high-contrast: ${Object.keys(ratios).length} text roles (text, links, accent, status and chart colours, badge, brand, code, terminal, buttons, chat bubble, inputs, borders) all 7:1 or better on their surface`, !!t && Object.keys(ratios).length >= 80 && low.length === 0 && t['--os-card'] === (mode === 'light' ? '#ffffff' : '#000000'), JSON.stringify(low.map(([k, r]) => `${k} ${Number(r).toFixed(1)}`)));
  }
  const OI = ['#0072b2', '#e69f00', '#d55e00', '#cc79a7', '#56b4e9', '#009e73', '#f0e442'];
  const near = (a, b) => { const x = ct.parseColor(a), y = ct.parseColor(b); return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) < 24; };
  const hueOf = (c) => { const { r, g, b } = ct.parseColor(c); const max = Math.max(r, g, b), min = Math.min(r, g, b); if (max === min) return null; const d = max - min; let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60; };
  const sameHue = (a, b) => { const x = hueOf(a), y = hueOf(b); if (x === null || y === null) return x === y; const d = Math.abs(x - y); return Math.min(d, 360 - d) < 12; };
  const lum = (c) => ct.luminance(c);
  for (const kind of ['protanopia', 'deuteranopia', 'tritanopia']) {
    for (const [selector, mode] of [[`html.ra-cv-${kind} body`, 'light'], [`html.dark.ra-cv-${kind} body`, 'dark']]) {
      const t = block(selector);
      const bg = mode === 'light' ? '#ffffff' : '#17141f';
      const codeBg = mode === 'light' ? '#f6f8fa' : '#141120';
      const ratios = t ? {
        link: ct.contrastRatio(t['--md-link'], bg), appLink: ct.contrastRatio(t['--link'], bg), accent: ct.contrastRatio(t['--os-blue'], bg), good: ct.contrastRatio(t['--chart-good'], bg), warn: ct.contrastRatio(t['--chart-warn'], bg), bad: ct.contrastRatio(t['--chart-bad'], bg), important: ct.contrastRatio(t['--ra-callout-important'], bg), statusWarn: ct.contrastRatio(t['--color-status-warning'], bg), statusDanger: ct.contrastRatio(t['--color-status-danger'], bg), badge: ct.contrastRatio(t['--rail-badge'], bg),
        successButton: ct.contrastRatio('#ffffff', t['--btn-success-bg']), warningButton: ct.contrastRatio('#ffffff', t['--btn-warning-bg']), dangerButton: ct.contrastRatio('#ffffff', t['--btn-danger-solid-bg']),
        ...Object.fromEntries(CODE.map((k) => ['code-' + k, ct.contrastRatio(t[`--os-code-${k}`], codeBg)])),
      } : {};
      const low = Object.entries(ratios).filter(([, r]) => r < 4.5);
      const coloured = t ? Object.entries(t).filter(([k, v]) => k !== '--os-code-comment' && /^#[0-9a-f]{6}$/i.test(v) && !/^#(ffffff|000000)$/i.test(v) && hueOf(v) !== null).map(([, v]) => v) : [];   // greys (the eighth category) carry no hue
      const okabe = coloured.every((v) => OI.some((o) => sameHue(v, o) || near(v, o)));
      const redGreen = kind === 'tritanopia' || !coloured.some((v) => sameHue(v, '#16a34a') || sameHue(v, '#22c55e'));   // no stock green; the Okabe-Ito bluish green is made to be told from vermillion and orange
      const apart = t && !sameHue(t['--chart-good'], t['--chart-warn']) && !sameHue(t['--chart-warn'], t['--chart-bad']) && !sameHue(t['--chart-good'], t['--chart-bad']) && Math.abs(lum(t['--chart-warn']) - lum(t['--chart-bad'])) > 0.04;
      const fams = ['info', 'success', 'warning', 'danger', 'brand'];
      const famOk = t && fams.every((f) => t[`--status-${f}-fg`] && t[`--status-${f}-bg`] && t[`--status-${f}-border`]) && new Set(fams.map((f) => t[`--status-${f}-border`])).size === 5 && t['--status-info-border'] !== t['--os-blue'] && [1, 2, 3, 4, 5, 6, 7, 8].every((n) => t[`--chart-cat-${n}`]) && new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => t[`--chart-cat-${n}`])).size === 8 && t['--os-rail-active'] === 'var(--btn-primary-bg)' && !!t['--brand-accent'];
      check(`1b. ${kind} (${mode}): links, the accent, good / warning / bad (charts, status, badge, solid buttons under white text), the important callout and the nine syntax colours are Okabe-Ito hues at 4.5:1 or better${kind === 'tritanopia' ? '' : ', with no green'}; good, warning and bad differ in hue and warning / bad in lightness; the five status families are set and distinct (info apart from the accent), the eight categories distinct, the rail's active item and the brand follow`, !!t && Object.keys(ratios).length === 22 && low.length === 0 && okabe && redGreen && apart && famOk, JSON.stringify({ low: low.map(([k, r]) => `${k} ${r.toFixed(1)}`), okabe, redGreen, apart, famOk }));
    }
  }
  check('1b. the Tailwind aliases (bg-os-card, text-os-text-primary, ...) and the button rings are declared again on <body> under the colour blocks, so the utilities follow the tokens there', /html:is\(\.ra-high-contrast, \.ra-cv-protanopia, \.ra-cv-deuteranopia, \.ra-cv-tritanopia\) body \{[^}]*--color-os-card: var\(--os-card\);[^}]*--color-os-text-primary: var\(--os-text-primary\);[^}]*--btn-primary-ring: color-mix\(in srgb, var\(--btn-primary-bg\) 40%, transparent\)/.test(css));
  check('1b. the important callout follows the palette (its own token, the keyword colour otherwise); a rail painted inline takes the high-contrast rail', /\.ra-app \.markdown-preview \.md-callout-important \{ --callout-color: var\(--ra-callout-important, var\(--os-code-keyword\)\); \}/.test(css) && /html\.ra-high-contrast \.sc-rail \{ background: var\(--os-rail\) !important/.test(css) && /className=\{`sc-rail w-16/.test(read('src/components/CompactSidebar.jsx')));
}

// ---- 2. jsdom
for (const dep of ['esbuild', 'jsdom', 'fake-indexeddb']) { try { req.resolve(dep); } catch { console.log(`SKIP: ${dep} is not installed (part 2)`); console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`); process.exit(failed ? 1 : 0); } }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-aids-'));
const ENTRY = path.join(WORK, 'entry.mjs');
fs.writeFileSync(ENTRY, `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import AccessibilitySettings from '@worktree/src/components/common/modals/settings/AccessibilitySettings.jsx';
  import ReadingAidsSurface, { useAppReadingAids } from '@worktree/src/components/common/ReadingAidsSurface.jsx';
  export { act } from 'react';
  export * as React from 'react';
  export { createRoot, AccessibilitySettings, ReadingAidsSurface, useAppReadingAids };
`);
const { build } = await import(req.resolve('esbuild'));
const BUNDLE = path.join(WORK, 'bundle.cjs');
await build({
  entryPoints: [ENTRY], bundle: true, outfile: BUNDLE, format: 'cjs', platform: 'node', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
  resolveExtensions: ['.jsx', '.js', '.mjs', '.json'], nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@worktree\// }, (a) => ({ path: path.join(REPO, a.path.replace(/^@worktree\//, '')) }));
    b.onResolve({ filter: /^[a-zA-Z][^:]*$|^@[a-zA-Z]/ }, (a) => { if (isBuiltin(a.path)) return { path: a.path, external: true }; try { return { path: req.resolve(a.path) }; } catch { return null; } });
  } }], logLevel: 'error',
});
await import(req.resolve('fake-indexeddb/auto'));
const { JSDOM } = await import(req.resolve('jsdom'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage']) define(key, window[key]);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0)); define('cancelAnimationFrame', (id) => clearTimeout(id));
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const origErr = console.error; console.error = (...a) => { if (/Warning:|act\(/.test(String(a[0] ?? ''))) return; origErr(...a); };
const { AccessibilitySettings, ReadingAidsSurface, useAppReadingAids, React, createRoot, act } = createRequire(import.meta.url)(BUNDLE);
const { document } = window;
const $ = (s) => document.querySelector(s);
const root = createRoot(document.getElementById('root'));
const render = async (el) => { await act(async () => { root.render(el); }); await act(async () => { await sleep(20); }); };
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); }); await act(async () => { await sleep(10); }); };
const select = async (el, value) => { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('change', { bubbles: true })); }); await act(async () => { await sleep(10); }); };
const range = async (el, value) => { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, String(value)); el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); }); await act(async () => { await sleep(10); }); };
const stored = () => JSON.parse(localStorage.getItem(RA.READING_AIDS_KEY) || 'null');
const html = document.documentElement;
const Shell = () => { useAppReadingAids(); return null; };

try {
  await render(React.createElement('div', null, React.createElement(Shell), React.createElement(AccessibilitySettings), React.createElement(ReadingAidsSurface, { testId: 'page-surface' }, React.createElement('p', null, 'doc'))));
  const labelled = ['ra-line-height', 'ra-paragraph-spacing', 'ra-letter-spacing', 'ra-word-spacing', 'ra-line-width', 'ra-font', 'ra-color-vision', 'ra-saturation'].every((id) => $(`#${id}`) && $(`label[for="${id}"]`));
  const switches = ['ra-ruler', 'ra-hide-images', 'ra-links', 'ra-high-contrast', 'ra-greyscale'].every((id) => $(`[data-testid="${id}"]`)?.getAttribute('role') === 'switch');
  check('2. the panel: two groups (Everywhere, Reading text everywhere - the column, the alignment and zen in the second), every select and slider labelled, every toggle a switch, the alignment and the ruler\'s height / style as groups, Reset disabled at the defaults, the sample shows', ['app', 'reading'].every((g) => $(`[data-testid="ra-group-${g}"]`)) && !$('[data-testid="ra-group-documents"]') && $('[data-testid="ra-group-app"] [data-testid="ra-high-contrast"]') && $('[data-testid="ra-group-reading"] [data-testid="ra-ruler"]') && $('[data-testid="ra-group-reading"] #ra-line-width') && $('[data-testid="ra-group-reading"] [data-testid="ra-zen"]') && labelled && switches && ['ra-text-align', 'ra-ruler-lines', 'ra-ruler-mode'].every((id) => $(`[data-testid="${id}"]`)?.getAttribute('role') === 'group') && $('[data-testid="ra-reset"]').disabled && !!$('[data-testid="ra-sample-preview"]') && !$('[data-testid="ra-active-note"]'), JSON.stringify([labelled, switches]));
  check('2. the shell\'s hook puts ra-app alone on <html> at the defaults (no --ra-* property)', html.classList.contains('ra-app') && Array.from(html.classList).filter((c) => c.startsWith('ra-')).join() === 'ra-app' && html.getAttribute('style') === null || html.getAttribute('style') === '');
  await select($('#ra-line-height'), '2');
  await range($('#ra-letter-spacing'), 0.05);
  await click($('[data-testid="ra-ruler"]'));
  await click($('[data-testid="ra-ruler-mode"] button:last-child'));
  await click($('[data-testid="ra-ruler-lines"] button:nth-child(2)'));
  await select($('#ra-font'), 'lexend');
  await select($('#ra-line-width'), '70');
  const page = $('[data-testid="page-surface"]');
  check('2. a change writes the setting (the differences only); <html> carries the app-wide vars and classes at once (line height, letters, the font, the ruler in mask mode at 3 lines) and the column with its gate; the document surface carries its class alone', JSON.stringify(stored()) === JSON.stringify({ lineHeight: 2, letterSpacing: 0.05, lineWidth: 70, font: 'lexend', ruler: true, rulerLines: 3, rulerMode: 'mask' }) && html.style.getPropertyValue('--ra-line-height') === '2' && html.style.getPropertyValue('--ra-letter-spacing') === '0.05em' && /Lexend/.test(html.style.getPropertyValue('--ra-font-family')) && html.style.getPropertyValue('--ra-ruler-lines') === '3' && html.style.getPropertyValue('--ra-max-width') === '70ch' && html.classList.contains('ra-width') && html.classList.contains('ra-line') && html.classList.contains('ra-ruler') && html.classList.contains('ra-ruler-mask') && !page.style.getPropertyValue('--ra-max-width') && !page.style.getPropertyValue('--ra-font-family') && !page.classList.contains('ra-ruler'), JSON.stringify([stored(), html.getAttribute('style'), html.className, page.getAttribute('style'), page.className]));
  // the text-size slider: aria, live while it moves (<html> first, storage later), committed on change, PageUp / PageDown
  const slider = $('[data-testid="ra-text-scale"]');
  check('2. the text-size slider: a range 90-200 in 5 % steps with the value spelled out (aria-valuetext "100 %"), its tick marks (Default, 125, 150, 175, 200 %), labelled', slider && slider.type === 'range' && slider.min === '90' && slider.max === '200' && slider.step === '5' && slider.getAttribute('aria-valuetext') === '100 %' && !!$('label[for="ra-text-scale"]') && !!document.getElementById(slider.getAttribute('list')) && Array.from(document.getElementById(slider.getAttribute('list')).options).map((o) => o.label).join() === 'Default,125 %,150 %,175 %,200 %', slider && [slider.min, slider.max, slider.step, slider.getAttribute('aria-valuetext')].join());
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(slider, '150'); slider.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await act(async () => { await sleep(30); });   // one animation frame
  check('2. moving it applies live: <html> carries --ra-text-scale 1.5 and the value reads "150 %" while nothing is stored yet', html.style.getPropertyValue('--ra-text-scale') === '1.5' && slider.getAttribute('aria-valuetext') === '150 %' && !(stored() && stored().textScale), JSON.stringify([html.getAttribute('style'), stored()]));
  await act(async () => { slider.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(async () => { await sleep(20); });
  check('2. releasing it commits: textScale 150 stored, the Back to 100 % button shows', stored() && stored().textScale === 150 && !!$('[data-testid="ra-text-scale-reset"]'), JSON.stringify(stored()));
  await act(async () => { slider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true })); });
  await act(async () => { await sleep(30); });
  check('2. PageUp moves 25 % and commits (175); the slider\'s own arrows move its 5 % step natively', stored() && stored().textScale === 175 && html.style.getPropertyValue('--ra-text-scale') === '1.75', JSON.stringify(stored()));
  await click($('[data-testid="ra-text-scale-reset"]'));
  check('2. Back to 100 % clears the scale', !(stored() && stored().textScale) && !html.style.getPropertyValue('--ra-text-scale') && !$('[data-testid="ra-text-scale-reset"]'));
  check('2. the sliders show the value, Reset is enabled, the "on" note shows', $('[data-testid="ra-letter-spacing"]').getAttribute('aria-valuetext') === '0.05 em' && !$('[data-testid="ra-reset"]').disabled && !!$('[data-testid="ra-active-note"]'));
  await click($('[data-testid="ra-greyscale"]'));
  check('2. greyscale disables the saturation slider and puts grayscale(1) on <html>', $('[data-testid="ra-saturation"]').disabled && html.style.getPropertyValue('--ra-filter') === 'grayscale(1)');
  await click($('[data-testid="ra-high-contrast"]'));
  await select($('#ra-color-vision'), 'tritanopia');
  check('2. high contrast and a palette are classes on <html>', html.classList.contains('ra-high-contrast') && html.classList.contains('ra-cv-tritanopia'));
  await click($('[data-testid="ra-reset"]'));
  check('2. Reset to defaults: nothing stored, <html> back to ra-app alone with no --ra-* property, the document surface bare, the controls back', stored() === null && Array.from(html.classList).filter((c) => c.startsWith('ra-')).join() === 'ra-app' && !html.style.getPropertyValue('--ra-line-height') && !html.style.getPropertyValue('--ra-filter') && !page.getAttribute('style') && page.className.trim() === 'ra-surface' && $('[data-testid="ra-reset"]').disabled && $('#ra-line-height').value === '0', JSON.stringify([stored(), html.getAttribute('style'), html.className, page.getAttribute('style')]));
  await click($('[data-testid="ra-zen"]'));
  check('2. the zen button toggles the mode (a class on <html>, the button pressed) and leaves the stored settings alone', html.classList.contains('zen-mode') && $('[data-testid="ra-zen"]').getAttribute('aria-pressed') === 'true' && stored() === null);
  await click($('[data-testid="ra-zen"]'));
  check('2. ...and back', !html.classList.contains('zen-mode'));
  await render(null);
  // hidden images (src/components/features/documents/hiddenImages.js) on a preview-like DOM
  const HI = await import(path.join(REPO, 'src/components/features/documents/hiddenImages.js'));
  const prev = document.createElement('div');
  prev.className = 'markdown-preview';
  prev.innerHTML = '<p>text</p><p><img src="https://example.test/a.png" alt="A diagram"></p><p><img src="https://example.test/b.png"></p>';
  const revealed = new Set();
  const added = HI.applyHiddenImages(prev, revealed);
  const boxes = () => Array.from(prev.querySelectorAll('.ra-image-placeholder'));
  check('2. hide images: each image gives way to a placeholder naming it (alt text, or "no description") with a Show image button; the image stays, hidden', added === 2 && boxes().length === 2 && boxes()[0].querySelector('.ra-image-alt').textContent === 'Image: A diagram' && boxes()[1].querySelector('.ra-image-alt').textContent === 'Image (no description)' && boxes()[0].querySelector('button.ra-image-show').getAttribute('aria-label') === 'Show image: A diagram' && Array.from(prev.querySelectorAll('img')).every((i) => i.hidden && i.hasAttribute('data-ra-hidden')), prev.innerHTML.slice(0, 300));
  check('2. ...a second run changes nothing (safe under a MutationObserver)', HI.applyHiddenImages(prev, revealed) === 0 && boxes().length === 2);
  let bubbled = false;
  prev.addEventListener('click', () => { bubbled = true; });
  boxes()[0].querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  check('2. Show image brings that image back, drops its placeholder, remembers the source, and the click does not reach the preview', boxes().length === 1 && !prev.querySelector('img[alt="A diagram"]').hidden && revealed.has('https://example.test/a.png') && !bubbled);
  prev.innerHTML = '<p>text</p><p><img src="https://example.test/a.png" alt="A diagram"></p><p><img src="https://example.test/b.png"></p>';
  HI.applyHiddenImages(prev, revealed);
  check('2. after a re-render the revealed image stays shown, the other is hidden again', boxes().length === 1 && !prev.querySelector('img[alt="A diagram"]').hidden && prev.querySelector('img[src$="b.png"]').hidden);
  HI.restoreHiddenImages(prev);
  check('2. turning the setting off restores every image and removes the placeholders', boxes().length === 0 && Array.from(prev.querySelectorAll('img')).every((i) => !i.hidden && !i.hasAttribute('data-ra-hidden')));
  // the wiring
  const cm = read('src/components/features/documents/codemirror/CodeMirrorSurface.js');
  const shell = read('src/components/JQLBuilder.jsx');
  const rail = read('src/components/CompactSidebar.jsx');
  const page_ = read('src/components/DocumentsPage.jsx');
  const css_ = read('src/index.css');
  check('2. the editor has no active-line marker of any kind (no highlightActiveLine, no cm-activeLine class, no activeLineMarker file): with the ruler off its DOM is what it was', !/highlightActiveLine|activeLineMarker|cm-activeLine/.test(cm) && !fs.existsSync(path.join(REPO, 'src/components/features/documents/codemirror/activeLineMarker.js')) && !/cm-activeLine\b(?!Gutter)/.test(css_));
  check('2. the shell applies the app surface, mounts the ruler overlay only while the setting is on, and hides images everywhere; hidden images scope is markdown previews and marked reading areas', /const readingAids = useAppReadingAids\(\);\s*useHiddenImages\(readingAids\.hideImages\);/.test(shell) && /\{readingAids\.ruler && <ReadingRuler lines=\{readingAids\.rulerLines\} mode=\{readingAids\.rulerMode\} \/>\}/.test(shell) && /HIDDEN_IMAGE_SCOPE = '\.markdown-preview, \.ra-reading'/.test(read('src/hooks/useHiddenImages.js')) && !/applyHiddenImages|useReadingAids/.test(read('src/components/features/documents/DocumentEditor.jsx')));
  check('2. the ruler overlay: one fixed, clipped, pointer-transparent element below dialogs and menus (z 40); it stays when the pointer leaves (no pointerout hiding; a childList observer finds the next reading area); the band has no edge (no box-shadow inset, no border); mask dims towards the surface colour', /\.ra-ruler-clip \{ position: fixed; z-index: 40; pointer-events: none; overflow: hidden; \}/.test(css_) && !/pointerout/.test(read('src/components/common/ReadingRuler.jsx')) && /new MutationObserver\(scheduleEnsure\)/.test(read('src/components/common/ReadingRuler.jsx')) && /\.ra-ruler-band \{ position: absolute; left: 0; right: 0; background-color: var\(--ra-ruler-bg\); \}/.test(css_) && !/ra-ruler-edge|inset 3px/.test(css_.slice(css_.indexOf('/* ==== Reading aids'))) && /\.ra-ruler-mask \.ra-ruler-band \{ background-color: transparent; box-shadow: none; \}/.test(css_) && /\.ra-ruler-shade \{ position: fixed; inset: 0; z-index: 40; pointer-events: none; background-color: var\(--ra-mask-bg\); \}/.test(css_) && /shade\.style\.clipPath = has/.test(read('src/components/common/ReadingRuler.jsx')) && /--ra-mask-bg: color-mix\(in srgb, var\(--os-card\) 55%, transparent\)/.test(css_) && /caretRangeFromPoint/.test(read('src/components/common/ReadingRuler.jsx')) && /selectionchange/.test(read('src/components/common/ReadingRuler.jsx')) && /ArrowUp/.test(read('src/components/common/ReadingRuler.jsx')));
  check('2. the Preview takes keyboard focus (tabIndex) so the arrows can move the band; the sample too', /className="markdown-preview h-full px-6 py-4 overflow-y-auto bg-os-card"\s*tabIndex=\{0\}/.test(read('src/components/features/documents/DocumentEditor.jsx')) && /data-testid="ra-sample-preview" tabIndex=\{0\}/.test(read('src/components/common/modals/settings/AccessibilitySettings.jsx')));
  check('2. zen mode: the rail hides itself (not unmounted: it hosts the Settings dialog), the Documents page drops its sidebar and keeps both tab bars (as every page keeps its tab strip), shows a status hint; the shell leaves on Esc (unless a dialog has the key) and keeps zen across pages; every page sidebar steps aside through ResizableSidebar with a left-edge pull-out tab ("Show sidebar" on every page, the chip "Sidebar") opening it as an overlay, the panels hide', /const zen = useZenMode\(\)/.test(rail) && /\.\.\.\(zen \? \{ display: 'none' \} : \{\}\)/.test(rail) && /\(innerSidebarVisible \|\| isMobile \|\| zen\) && \(/.test(page_) && /zenLabel="Documents"/.test(page_) && /zenCloseOn=\{currentDocumentId\}/.test(page_)&& (page_.match(/\{!zen && \(\s*<TabBar/g) || []).length === 0 && (page_.match(/<TabBar/g) || []).length >= 2 && !/zen-hint/.test(page_) && /role="status" aria-live="polite" className="sr-only" data-testid="zen-announce"/.test(read('src/components/common/ZenBadge.jsx'))&& /e\.key !== 'Escape' \|\| e\.defaultPrevented \|\| document\.querySelector\('\[role="dialog"\]'\)/.test(read('src/components/JQLBuilder.jsx')) && !/zenMode\.set\(false\)/.test(page_) && /if \(!overlay && zen && !isMobile\) \{\s*if \(canvasMinWidth != null \|\| zenLabel == null\) return null;/.test(read('src/components/ResizableSidebar.jsx')) && /<ZenEdgeTab side="left"[^\n]*testId="zen-sidebar-button"/.test(read('src/components/ResizableSidebar.jsx')) && /testId="zen-sidebar-overlay"/.test(read('src/components/ResizableSidebar.jsx')) && /role="dialog"[\s\S]*<ResizableSidebar overlay/.test(read('src/components/common/ZenSideOverlay.jsx')) && /zenLabel="Sections"/.test(read('src/components/DiagnosticsPage.jsx')));
  check('2. the stylesheet: the font and spacing on html.ra-app with today\'s values as fallbacks, reset on code, terminals, logs, icons and tabular numbers; line height and paragraph spacing in reading areas only, chat keeping its own base; the column and alignment on the document surface; the filter on <html>', /html\.ra-app \{[^}]*--font-reading: var\(--ra-font-family, "Red Hat Text", Roboto, sans-serif\);[^}]*letter-spacing: var\(--ra-letter-spacing, var\(--app-letter-spacing\)\);[^}]*filter: var\(--ra-filter, none\);/.test(css_) && /html\.ra-app :is\(code, pre, kbd, samp, \.font-mono, \.os-terminal, \.hljs, svg, \.tabular-nums,[^{]*#diagnostics-content :is\(pre, \.ui-mono, \.ui-code, \.ui-code-lines, \.ui-cmd, \.ui-xrow-body\)\) \{ letter-spacing: 0; word-spacing: normal; \}/.test(css_) && /\.ra-app \.sc-chat-markdown \{ --ra-line-base: var\(--sc-chat-line\); --ra-para-base: 0\.6em; \}/.test(css_) && /\.ra-app :is\(\.markdown-preview, \.ra-reading\) p \{ margin-bottom: var\(--ra-paragraph-spacing, var\(--ra-para-base\)\); \}/.test(css_) && /\.ra-surface \.markdown-preview \{\s*text-align: var\(--ra-text-align, start\);/.test(css_) && /padding-inline: max\(1\.5rem, calc\(\(100% - var\(--ra-max-width, 100%\)\) \/ 2\)\)/.test(css_) && !/ra-zen-width|80ch/.test(css_));
  check('2. text size in the stylesheet: the reading areas take their rem / em base times --ra-reading-scale (the Preview 1rem, chat its own, a text-sm area 0.875rem), the editor and its gutter scale, the report root, its cells, badges and monospace parts in rem times the scale (one factor for the whole report), the interface toggle scales the root rem and sets the reading scale to one, the window never scrolls, the sidebars and the rail follow the scale, the rail tooltip pairs its own text token', /html\.ra-app \{ --ra-reading-scale: var\(--ra-text-scale, 1\); --ra-chrome-scale: 1; \}/.test(css_) && /html\.ra-app\.ra-scale-chrome \{ --ra-reading-scale: 1; --ra-chrome-scale: var\(--ra-text-scale, 1\); font-size: calc\(100% \* var\(--ra-text-scale, 1\)\); \}/.test(css_) && /\.ra-app \.markdown-preview \{ --ra-font-base: 1rem; \}/.test(css_) && /\.ra-app \.sc-chat-markdown \{ --ra-font-base: var\(--sc-chat-font\); \}/.test(css_) && /\.ra-reading-sm \{ --ra-font-base: 0\.875rem; \}/.test(css_) && /\.ra-app :is\(\.markdown-preview, \.ra-reading\) \{ font-size: calc\(var\(--ra-font-base, 1em\) \* var\(--ra-reading-scale, 1\)\); \}/.test(css_) && /\.ra-app \.sc-editor-cm\.cm-editor \{ font-size: calc\(0\.875rem \* var\(--ra-reading-scale, 1\)\); \}/.test(css_) && /\.ra-app \.sc-editor-cm \.cm-gutters \{ font-size: calc\(0\.75rem \* var\(--ra-reading-scale, 1\)\); font-family: var\(--font-mono\); \}/.test(css_) && /\.ra-app #diagnostics-content \{ font-size: calc\(0\.8125rem \* var\(--ra-reading-scale, 1\)\); \}/.test(css_) && /\.ra-app #diagnostics-content \.ui-code-lines \{ font-size: calc\(0\.75rem \* var\(--ra-reading-scale, 1\)\); \}/.test(css_) && /\.ra-app #diagnostics-content table td \{ font-size: calc\(0\.78125rem \* var\(--ra-reading-scale, 1\)\); \}/.test(css_) && /\.ra-app #diagnostics-content \.ui-badge \{ font-size: calc\(0\.65625rem/.test(css_) && /html\.ra-app, html\.ra-app body \{ height: 100%; overflow: hidden; \}/.test(css_) && /--ra-chrome-scale: var\(--ra-text-scale, 1\)/.test(css_) && /calc\(\$\{width\}px \* var\(--ra-chrome-scale, 1\)\)/.test(read('src/components/ResizableSidebar.jsx')) && !/sc-rail-scroll|overflow-y-auto overscroll-contain/.test(read('src/components/CompactSidebar.jsx')) && /const buttonHeight = 48 \* u;/.test(read('src/components/CompactSidebar.jsx')) && /addEventListener\('documentsReadingAidsChanged', recalc\)/.test(read('src/components/CompactSidebar.jsx')) && !/sc-rail-scroll/.test(css_) && /text-\(--os-rail-tooltip-text\)/.test(read('src/components/CompactSidebar.jsx')) && /ra-reading ra-reading-sm/.test(read('src/components/tasks/TaskItem.jsx')) && /ra-reading ra-reading-xs text-xs/.test(read("src/components/kanban/KanbanCard.jsx")));
  check('2. the Diagnostics frame bridge carries the ra-* classes (the srcdoc and the live message) and the frame reads its tokens from <body>; the PDF export renders outside any surface', /classes: Array\.from\(root\.classList\)\.filter\(\(c\) => c\.startsWith\('ra-'\)\)/.test(read('src/components/DiagnosticsPage.jsx')) && /htmlClasses = \[theme\.dark \? 'dark' : '', \.\.\.\(theme\.classes \|\| \[\]\)/.test(read('src/components/DiagnosticsPage.jsx')) && /wanted\.forEach\(function \(c\) \{ html\.classList\.add\(c\); \}\)/.test(read('src/components/DiagnosticsPage.jsx')) && /getComputedStyle\(document\.body \|\| document\.documentElement\)\.getPropertyValue\(TOKENS\[role\]/.test(read('src/components/DiagnosticsPage.jsx')) && /container\.className = 'markdown-preview pdf-export-root'/.test(read('src/utils/pdfExportNative.js')) && !/ra-surface|readingAids/.test(read('src/utils/pdfExportNative.js')));
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
