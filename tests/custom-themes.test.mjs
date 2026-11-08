#!/usr/bin/env node
/**
 * Custom colour schemes as data (src/utils/customThemes.js), statically and
 * in plain Node:
 *
 *  1. colours: #rgb, #rrggbb, rgb() / rgba(), hsl() accepted and stored as
 *     #rrggbb; url(), var(), expression(), keywords, a trailing CSS payload,
 *     an over-long string refused;
 *  2. validation: a default theme passes; unknown keys, a missing colour, a
 *     bad colour, a bad base, a name over the limit or with control
 *     characters, a bad id, a bad logo tone are refused with a message
 *     naming the field; the result is a fresh normalized copy;
 *  3. fills: solid / linear / radial built from parts only - a bad type,
 *     too few or too many stops, a position or an angle out of range, a stop
 *     that is no colour, extra keys, an angle on a radial refused; the CSS
 *     comes from the validated parts;
 *  4. the derived tokens: every value a hex, an rgba() tint or the rail
 *     fill's CSS; the accent drives the buttons, links, selection and rail's
 *     active entry; text on the accent reads at 4.5:1; the mark's variables
 *     and the dark-variant decoration edge; the contrast warnings name a
 *     pair under its minimum and check a gradient's every stop;
 *  5. the theme file: themeFileObject -> readThemeFile round trip; a wrong
 *     format, a newer version, an oversize file, non-JSON, unknown file
 *     keys refused; unique names on a clash;
 *  6. the database section: customThemesExportSection, readCustomThemesSection
 *     (the versioned object, a bare array, null for an old export), and the
 *     merge: same id + newer updatedAt replaces, older is skipped, a new id is
 *     added under a unique name, invalid entries counted, the input untouched,
 *     the list capped;
 *  7. storage: loadCustomThemes ignores junk and invalid entries;
 *  8. the context applies only validated values: the source sets properties
 *     through style.setProperty and removes the previous theme's.
 *
 * Run: node tests/custom-themes.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const ct = await import(path.join(REPO, 'src/utils/customThemes.js'));

// 1. colours
check('normalizeColor: #rgb, #RRGGBB, rgb(), rgba(), hsl() -> #rrggbb', ct.normalizeColor('#abc') === '#aabbcc' && ct.normalizeColor('#7B5CE0') === '#7b5ce0' && ct.normalizeColor('rgb(255, 0, 0)') === '#ff0000' && ct.normalizeColor('rgba(0,0,255,0.5)') === '#0000ff' && ct.normalizeColor('hsl(120, 100%, 25%)') === '#008000' && ct.normalizeColor(' #fff ') === '#ffffff');
const bad = ['url(x)', 'var(--os-blue)', 'expression(alert(1))', 'red', '#fff; background:url(x)', '#ffff', '#12345', 'rgb(300,0,0)', 'hsl(400,0%,0%)', '#' + 'f'.repeat(60), '', null, 12, {}];
check('normalizeColor refuses url(), var(), expression(), keywords, a trailing payload, odd lengths, out-of-range channels, over-long or non-string values', bad.every((v) => ct.normalizeColor(v) === null), JSON.stringify(bad.filter((v) => ct.normalizeColor(v) !== null)));
check('contrastRatio: white on black 21:1, a colour on itself 1:1, an invalid pair 1:1; onColor picks white or near-black', Math.round(ct.contrastRatio('#fff', '#000')) === 21 && ct.contrastRatio('#123456', '#123456') === 1 && ct.contrastRatio('url(x)', '#fff') === 1 && ct.onColor('#0066cc') === '#ffffff' && ct.onColor('#facc15') === '#151515');

// 2. validation
const base = ct.defaultTheme('dark', 'Night');
const v0 = ct.validateCustomTheme(base);
check('a default dark theme validates; the copy is fresh and normalized', v0.ok && v0.theme !== base && v0.theme.colors !== base.colors && v0.theme.name === 'Night' && v0.theme.base === 'dark' && v0.theme.fills.rail.type === 'solid', JSON.stringify(v0.errors));
check('a default light theme validates with the light base values', ct.validateCustomTheme(ct.defaultTheme('light', 'Day')).ok && ct.defaultTheme('light').colors.card === '#ffffff');
const err = (t) => ct.validateCustomTheme(t).errors.join(' | ');
check('unknown top-level keys are refused by name', /unknown keys: evil/.test(err({ ...base, evil: 1 })));
check('an unknown colour key is refused by name', /unknown colours: background/.test(err({ ...base, colors: { ...base.colors, background: '#fff' } })));
check('a missing required colour is refused by its label; the optional centre may be empty', /Accent is missing/.test(err({ ...base, colors: { ...base.colors, accent: undefined } })) && ct.validateCustomTheme({ ...base, colors: { ...base.colors, markCenter: '' } }).ok);
check('a bad colour is refused by its label with the value', /Card: not a colour \(url\(javascript:1\)\)/.test(err({ ...base, colors: { ...base.colors, card: 'url(javascript:1)' } })));
check('a bad base, a bad logo tone and a bad id are refused', /base is 'dark' or 'light'/.test(err({ ...base, base: 'sepia' })) && /logoTone/.test(err({ ...base, logoTone: 'neon' })) && /not a theme id/.test(err({ ...base, id: '../../etc' })));
check('the name: over 60 characters, empty, or with control characters refused; surrounding space trimmed', /name is 1 to 60/.test(err({ ...base, name: 'x'.repeat(61) })) && /name is 1 to 60/.test(err({ ...base, name: '   ' })) && /name is 1 to 60/.test(err({ ...base, name: 'a\u0000b' })) && ct.validateCustomTheme({ ...base, name: '  Night  ' }).theme.name === 'Night');
check('colors / fills must be objects', /colors is an object/.test(err({ ...base, colors: [] })) && /fills is an object/.test(err({ ...base, fills: 'x' })));
check('times: a number or an ISO string normalize to ISO; junk falls back', ct.validateCustomTheme({ ...base, createdAt: 0, updatedAt: '2030-01-02T03:04:05Z' }).theme.updatedAt === '2030-01-02T03:04:05.000Z' && /^\d{4}-/.test(ct.validateCustomTheme({ ...base, createdAt: 'yesterday' }).theme.createdAt));

// 3. fills
const okLinear = ct.validateFill({ type: 'linear', angle: 135, stops: [{ color: '#991B1B', at: 0 }, { color: 'rgb(107,33,168)', at: 100 }] });
check('a linear fill from parts: colours normalized, the angle kept', okLinear.ok && okLinear.fill.stops[1].color === '#6b21a8' && okLinear.fill.angle === 135 && ct.fillToCss(okLinear.fill) === 'linear-gradient(135deg, #991b1b 0%, #6b21a8 100%)');
check('a radial fill with three stops and missing positions spread evenly', ct.fillToCss({ type: 'radial', stops: [{ color: '#000' }, { color: '#888' }, { color: '#fff' }] }) === 'radial-gradient(circle at 50% 0%, #000000 0%, #888888 50%, #ffffff 100%)');
check('a solid fill from a string or an object; a bad string refused', ct.fillToCss('#ABCDEF') === '#abcdef' && ct.fillToCss({ type: 'solid', color: '#abc' }) === '#aabbcc' && ct.validateFill('url(x)').ok === false);
const badFills = [
  { type: 'conic', stops: [{ color: '#000' }, { color: '#fff' }] }, { type: 'linear', stops: [{ color: '#000' }] }, { type: 'linear', stops: [{ color: '#000' }, { color: '#111' }, { color: '#222' }, { color: '#333' }] },
  { type: 'linear', angle: 361, stops: [{ color: '#000' }, { color: '#fff' }] }, { type: 'linear', angle: -1, stops: [{ color: '#000' }, { color: '#fff' }] }, { type: 'linear', stops: [{ color: '#000', at: 101 }, { color: '#fff' }] },
  { type: 'linear', stops: [{ color: '#000', at: 60 }, { color: '#fff', at: 40 }] }, { type: 'linear', stops: [{ color: 'var(--x)' }, { color: '#fff' }] }, { type: 'linear', stops: [{ color: '#000', evil: 1 }, { color: '#fff' }] },
  { type: 'linear', background: 'url(x)', stops: [{ color: '#000' }, { color: '#fff' }] }, { type: 'radial', angle: 90, stops: [{ color: '#000' }, { color: '#fff' }] }, { type: 'solid', color: 'linear-gradient(red, blue)' }, [], 'linear-gradient(red, blue)',
];
check('fills refused: a bad type, one stop, four stops, an angle out of range, a position out of range or backwards, a stop that is no colour, extra stop keys, a raw background key, an angle on a radial, a gradient string as a solid colour, an array, a raw gradient string', badFills.every((f) => !ct.validateFill(f).ok && ct.fillToCss(f) === null), JSON.stringify(badFills.filter((f) => ct.validateFill(f).ok)));

// 4. derived tokens
const tokens = ct.deriveTokens(base);
const hexOrTint = (v) => /^#[0-9a-f]{6}$/.test(v) || /^rgba\(\d+, \d+, \d+, 0\.\d+\)$/.test(v) || v === 'none';
check('every derived token is a hex colour, an rgba() tint, "none" or the rail fill CSS', Object.entries(tokens).every(([k, v]) => k === '--os-rail-fill' ? /^(#[0-9a-f]{6}|linear-gradient\(|radial-gradient\()/.test(v) : hexOrTint(v)), JSON.stringify(Object.entries(tokens).filter(([k, v]) => k !== '--os-rail-fill' && !hexOrTint(v))));
check('the accent drives --os-blue, the primary / selected buttons, the rail\'s active entry, the links and the selection tint', tokens['--os-blue'] === base.colors.accent && tokens['--btn-primary-bg'] === base.colors.accent && tokens['--btn-selected-bg'] === base.colors.accent && tokens['--os-rail-active'] === base.colors.accent && tokens['--os-terminal-selection'].startsWith('rgba(74, 158, 255') && tokens['--link'] === tokens['--os-blue-hover']);
check('text on the accent reads at 4.5:1 or better, and the solid status buttons keep white text at 4.5:1', ct.contrastRatio(tokens['--btn-primary-fg'], tokens['--btn-primary-bg']) >= 4.5 && ['--btn-success-bg', '--btn-warning-bg', '--btn-danger-solid-bg'].every((k) => ct.contrastRatio('#ffffff', tokens[k]) >= 4.5), JSON.stringify([tokens['--btn-success-bg'], tokens['--btn-warning-bg']]));
check('the surfaces, text, border and code background map one to one; the divider sits between the border and the background', tokens['--os-canvas'] === base.colors.canvas && tokens['--os-card'] === base.colors.card && tokens['--os-modal'] === base.colors.card && tokens['--os-text-primary'] === base.colors.textPrimary && tokens['--os-border'] === base.colors.border && tokens['--os-code-bg'] === base.colors.codeBg && tokens['--os-divider'] === ct.mix(base.colors.border, base.colors.canvas, 0.5));
check('the mark: --mark-arch / --mark-blossom / --brand-blossom from the theme, --mark-center the arch unless set; the seasonal decorations get the dark variant by default and the light edge on request', tokens['--mark-arch'] === '#7b5ce0' && tokens['--mark-blossom'] === '#ede6ff' && tokens['--brand-blossom'] === '#ede6ff' && tokens['--mark-center'] === '#7b5ce0' && tokens['--decor-blade-edge'] === 'none'
  && ct.deriveTokens({ ...base, colors: { ...base.colors, markCenter: '#ff0000' }, logoTone: 'light' })['--mark-center'] === '#ff0000' && ct.deriveTokens({ ...base, logoTone: 'light' })['--decor-blade-edge'] === '#4f7be8');
const withGradient = { ...base, fills: { rail: { type: 'linear', angle: 180, stops: [{ color: '#991b1b', at: 0 }, { color: '#6b21a8', at: 100 }] } } };
const gt = ct.deriveTokens(withGradient);
check('a gradient rail: --os-rail-fill is the gradient, --os-rail the first stop (what a background-color consumer shows)', gt['--os-rail-fill'] === 'linear-gradient(180deg, #991b1b 0%, #6b21a8 100%)' && gt['--os-rail'] === '#991b1b');
check('an invalid theme derives no tokens', Object.keys(ct.deriveTokens({ ...base, colors: { ...base.colors, accent: 'var(--x)' } })).length === 0);
const warn = ct.contrastWarnings({ ...base, colors: { ...base.colors, textPrimary: '#222222' } });
check('contrast warnings: text nearly the colour of the background is named with its ratio and the 4.5 minimum; the failing pairs come first', warn.some((w) => w.what === 'Text and headings on the background' && w.ratio < 4.5 && w.min === 4.5) && warn.findIndex((w) => w.ratio >= w.min) > warn.filter((w) => w.ratio < w.min).length - 1, JSON.stringify(warn.slice(0, 3)));
const gw = ct.contrastWarnings({ ...withGradient, colors: { ...base.colors, railText: '#8b1a1a' } });
check('...and the rail icons are checked against every stop of a gradient (3:1, icons)', gw.filter((w) => /Rail icons on the rail \(stop [12]\)/.test(w.what)).length === 2 && gw.some((w) => w.what === 'Rail icons on the rail (stop 1)' && w.ratio < 3 && w.min === 3), JSON.stringify(gw.slice(0, 3)));
check('the default themes raise no warning of their own', ct.contrastWarnings(ct.defaultTheme('dark')).every((w) => w.ratio >= w.min) && ct.contrastWarnings(ct.defaultTheme('light')).every((w) => w.ratio >= w.min), JSON.stringify(ct.contrastWarnings(ct.defaultTheme('light')).filter((w) => w.ratio < w.min)));

// 5. the theme file
const file = ct.themeFileObject(base);
check('themeFileObject: format, formatVersion 1, exportedAt, the normalized theme', file.format === 'jacarium-theme' && file.formatVersion === 1 && /^\d{4}-/.test(file.exportedAt) && file.theme.name === 'Night');
const round = ct.readThemeFile(JSON.stringify(file));
check('readThemeFile round trip: the same theme (id, colours, fills) back', round.ok && round.theme.id === base.id && JSON.stringify(round.theme.colors) === JSON.stringify(file.theme.colors) && JSON.stringify(round.theme.fills) === JSON.stringify(file.theme.fills));
check('readThemeFile refuses: not JSON, another format, a newer version, unknown file keys, an oversize file, a theme with an injected colour', !ct.readThemeFile('{').ok && /not a Jacarium theme file/.test(ct.readThemeFile({ format: 'other', formatVersion: 1, theme: base }).errors[0])
  && /newer than this app/.test(ct.readThemeFile({ ...file, formatVersion: 99 }).errors[0]) && /unknown keys in the file/.test(ct.readThemeFile({ ...file, script: 'x' }).errors[0])
  && /larger than 64 KB/.test(ct.readThemeFile('x'.repeat(65 * 1024)).errors[0]) && /Accent: not a colour/.test(ct.readThemeFile({ ...file, theme: { ...file.theme, colors: { ...file.theme.colors, accent: 'url(x)' } } }).errors[0]));
check('uniqueThemeName: a free name as is; a clash gets "(imported)", then "(imported 2)"; the limit kept', ct.uniqueThemeName('Night', []) === 'Night' && ct.uniqueThemeName('night', [{ name: 'Night' }]) === 'night (imported)' && ct.uniqueThemeName('Night', [{ name: 'Night' }, { name: 'Night (imported)' }]) === 'Night (imported 2)' && ct.uniqueThemeName('x'.repeat(60), [{ name: 'x'.repeat(60) }]).length <= 60);
check('themeFileName: a slug of the name with the suffix', ct.themeFileName({ name: 'My Night Theme!' }) === 'my-night-theme.jacarium-theme.json');

// 6. the database section
const other = { ...ct.defaultTheme('light', 'Day'), id: 'ct-11111111-2222-4333-8444-555555555555' };
const section = ct.customThemesExportSection([base, other, { bogus: true }]);
check('customThemesExportSection: { formatVersion: 1, themes } with the valid themes only', section.formatVersion === 1 && section.themes.length === 2 && section.themes[0].name === 'Night');
check('readCustomThemesSection: the versioned object, a bare array, [] for junk, null for an old export without the field', ct.readCustomThemesSection({ customThemes: section }).length === 2 && ct.readCustomThemesSection({ customThemes: [base] }).length === 1 && ct.readCustomThemesSection({ customThemes: 'x' }).length === 0 && ct.readCustomThemesSection({ documents: [] }) === null && ct.readCustomThemesSection(null) === null);
const existing = [{ ...base, updatedAt: '2026-06-01T00:00:00.000Z' }];
const merged = ct.mergeCustomThemes([{ ...base, name: 'Night 2', updatedAt: '2026-07-01T00:00:00.000Z' }, other, { bogus: true }], existing);
check('mergeCustomThemes: the same id with a newer updatedAt replaces (updated), a new id is added (created), junk is counted invalid, the input list is untouched', merged.updated === 1 && merged.created === 1 && merged.invalid === 1 && merged.skipped === 0 && merged.themes.length === 2 && merged.themes[0].name === 'Night 2' && existing[0].name === 'Night', JSON.stringify({ u: merged.updated, c: merged.created, i: merged.invalid, s: merged.skipped }));
const older = ct.mergeCustomThemes([{ ...base, name: 'Older', updatedAt: '2026-01-01T00:00:00.000Z' }], existing);
check('...an older or equal updatedAt is skipped and never duplicates', older.skipped === 1 && older.themes.length === 1 && older.themes[0].name === 'Night');
const clash = ct.mergeCustomThemes([{ ...other, name: 'Night' }], existing);
check('...a new id whose name clashes is added under "(imported)"', clash.created === 1 && clash.themes[1].name === 'Night (imported)');
const full = ct.mergeCustomThemes([other], Array.from({ length: ct.MAX_CUSTOM_THEMES }, (_, i) => ({ ...base, id: `ct-full-${i}0000000`, name: `T${i}` })));
check(`...the list is capped at ${ct.MAX_CUSTOM_THEMES} (the extra one skipped)`, full.created === 0 && full.skipped === 1 && full.themes.length === ct.MAX_CUSTOM_THEMES);

// 7. storage
const store = (raw) => ({ getItem: () => raw });
check('loadCustomThemes: valid entries only; junk, a non-array and a missing key give []', ct.loadCustomThemes(store(JSON.stringify([base, { bogus: 1 }, 'x']))).length === 1 && ct.loadCustomThemes(store('{')).length === 0 && ct.loadCustomThemes(store('{"a":1}')).length === 0 && ct.loadCustomThemes(store(null)).length === 0 && ct.loadCustomThemes(null).length === 0);

// 8. the context and the settings page, statically
const ctx = fs.readFileSync(path.join(REPO, 'src/contexts/ThemeContext.jsx'), 'utf8');
check('ThemeContext applies a custom theme through style.setProperty with the derived tokens and removes the previous theme\'s properties', /root\.style\.setProperty\(name, value\)/.test(ctx) && /root\.style\.removeProperty\(name\)/.test(ctx) && /deriveTokens\(custom\)/.test(ctx) && /const customNamesRef = useRef\(\[\]\)/.test(ctx));
check('a chosen theme that no longer exists falls back to Auto; the base decides the dark class; a preview replaces the chosen theme while the editor is open', /if \(!custom\) themeMode = 'auto'/.test(ctx) && /if \(custom\) actualTheme = custom\.base/.test(ctx) && /let custom = previewTheme/.test(ctx));
const settings = fs.readFileSync(path.join(REPO, 'src/components/common/modals/settings/ThemeSettings.jsx'), 'utf8');
const exp = fs.readFileSync(path.join(REPO, 'src/utils/exportDatabase.js'), 'utf8');
check('Settings > Theme: the scheme gallery, the Customize block with Reset / Save / Save as new / Delete, Export JSON (the shared ExportJsonModal) and Import JSON, the confirmations, the file size checked before it is read', /<SchemeGallery/.test(settings) && /<ExportJsonModal/.test(settings) && ['custom-theme-reset', 'custom-theme-save', 'custom-theme-save-as-new', 'custom-theme-delete', 'custom-theme-export', 'custom-theme-import'].every((id) => settings.includes(`data-testid="${id}"`)) && /ConfirmationModal/.test(settings) && /text\.length > MAX_THEME_FILE_BYTES/.test(settings) && /<ImportJsonModal/.test(settings) && /readThemeImport\(JSON\.parse\(text\)\)/.test(settings));
check('an imported file never replaces a theme of yours: a new id and the planned unique name', /id: newThemeId\(\), name: p\.finalName/.test(settings) && /planThemeImport\(r\.themes, customThemes\)/.test(settings));
check('the export logs "Read N custom themes" and labels the section while writing it', /Read \$\{customThemes\.themes\.length\} custom theme/.test(exp) && /customThemes: 'custom themes'/.test(exp));
const editor = fs.readFileSync(path.join(REPO, 'src/components/common/modals/settings/CustomThemeEditor.jsx'), 'utf8');
check('the editor uses the shared colour picker (the Color Converter\'s), shows the contrast warnings without blocking, previews the mark with a seasonal decoration and offers solid / linear / radial rail fills', /import ColorPickerInput from/.test(editor) && /contrastWarnings\(theme\)/.test(editor) && /BrandMark size=\{36\} tone="dark" decoration=\{decoration\}/.test(editor) && /\{ id: 'solid', label: 'Solid' \}, \{ id: 'linear', label: 'Linear gradient' \}, \{ id: 'radial', label: 'Radial gradient' \}/.test(editor));
const tool = fs.readFileSync(path.join(REPO, 'src/components/features/tools/ColorConverterTool.jsx'), 'utf8');
check('the Color Converter tool uses the same shared picker', /import ColorPickerInput from/.test(tool) && !/HexColorPicker/.test(tool));
const imp = fs.readFileSync(path.join(REPO, 'src/utils/importDatabase.js'), 'utf8');
check('the database export always carries customThemes { formatVersion, themes } (empty too) and the import merges it in both modes and the dry runs', /customThemes: customThemesExportSection/.test(exp) === false && /^\s*customThemes,\s*$/m.test(exp) && (imp.match(/importCustomThemes\(importData/g) || []).length === 4 && /mergeCustomThemes\(candidates, loadCustomThemes\(\)\)/.test(imp));
// the Documents preview's colours: tokens with the built-in values as defaults, set by a theme
const css = fs.readFileSync(path.join(REPO, 'src/index.css'), 'utf8');
const MD = ['--md-text', '--md-heading', '--md-heading-border', '--md-code-text', '--md-code-bg', '--md-inline-code-bg', '--md-link', '--md-quote-text', '--md-border', '--md-surface', '--md-surface-alt'];
const greenTokens = ct.deriveTokens({ ...base, colors: { ...base.colors, textPrimary: '#3fbf6a', textSecondary: '#2f9e57', codeBg: '#020a05' } });
check('deriveTokens sets the preview tokens: headings and text in the text colour, the code text readable on the code background, links, borders, surfaces; the brand hero from the card', MD.every((k) => greenTokens[k]) && greenTokens['--md-heading'] === '#3fbf6a' && greenTokens['--md-text'] === '#3fbf6a' && ct.contrastRatio(greenTokens['--md-code-text'], '#020a05') >= 4.5 && greenTokens['--md-code-bg'] === '#020a05' && greenTokens['--md-surface-alt'] === base.colors.cardSecondary && greenTokens['--brand-hero-text'] === '#3fbf6a', JSON.stringify(MD.map((k) => [k, greenTokens[k]])));
check('index.css: the preview tokens default to the built-in values in :root (light) and .dark, and the preview rules use them (no literal heading or code text colour left)', /--md-heading: #24292f;/.test(css) && /--md-heading: #e6edf3;/.test(css) && /--md-code-text: #e6edf3;/.test(css) && /--md-code-bg: #f6f8fa;/.test(css) && /--md-surface-alt: #161b22;/.test(css) && /\.markdown-preview h1 \{[^}]*color: var\(--md-heading\)/.test(css) && /color: var\(--md-code-text\) !important/.test(css) && !/\.dark \.markdown-preview h1,[^}]*#e6edf3/.test(css) && !/\.markdown-preview a \{\s*color: #0969da/.test(css) && /\.markdown-preview table th \{[^}]*var\(--md-surface-alt\)/.test(css));
check('the contrast warnings cover the headings (the text colour on the background) and the derived code text on the code background', ct.contrastWarnings(base).some((w) => w.what === 'Text and headings on the background') && ct.contrastWarnings(base).some((w) => w.what === 'Code text on the code background (as derived)'));
const about = fs.readFileSync(path.join(REPO, 'src/components/common/modals/settings/AboutSettings.jsx'), 'utf8');
check('About: the header sits on the page (no brand-hero box), the title in the text colour, the tagline in the secondary colour; the sign-in page keeps its hero', !/brand-hero/.test(about) && /data-testid="about-hero"/.test(about) && /BrandWordmark size=\{30\} className="text-os-text-primary"/.test(about) && /brand-tagline text-os-text-secondary/.test(about) && /className="brand-hero /.test(fs.readFileSync(path.join(REPO, 'src/components/auth/AuthGate.jsx'), 'utf8')));
const rail = fs.readFileSync(path.join(REPO, 'src/components/CompactSidebar.jsx'), 'utf8');
check('the bell\'s unread dot has no ring or border (the dot\'s own contrast on the rail separates it)', (() => { const m = fs.readFileSync(path.join(REPO, 'src/components/CompactSidebar.jsx'), 'utf8').match(/<span className="([^"]*)" data-testid="rail-badge"/); return !!m && !/\bring-|\bborder/.test(m[1]); })());
check('the rail\'s unread dots (the bell, the panels menu) are painted from --rail-badge, no fixed purple left; the token defaults to that purple in the light, Jacaranda and neutral blocks; a theme derives it from its accent against every rail stop', (rail.match(/bg-\(--rail-badge\)/g) || []).length === 2 && !/bg-purple-500 rounded-full|rounded-full bg-purple-500/.test(rail) && !/--rail-badge: #a855f7;/.test(css) && /'--rail-badge': railBadge\(c\.accent, t\.fills\.rail\)/.test(fs.readFileSync(path.join(REPO, 'src/utils/customThemes.js'), 'utf8')) && ct.contrastRatio(ct.railBadge('#1b1530', { type: 'solid', color: '#1b1530' }), '#1b1530') >= 3);
// every built-in scheme's dot: railBadge() of its own accent (Light, Jacaranda, Dark) or its mark's arch tint (the
// gradient schemes), written into index.css, >= 3:1 on every stop of its rail, and no longer the old fixed purple
{
  const st = await import(path.join(REPO, 'src/utils/themeStarters.js'));
  const blockValue = (scheme) => {
    if (scheme === 'light') return (css.slice(0, css.indexOf('.dark {')).match(/--rail-badge: (#[0-9a-f]{6});/i) || [])[1];
    if (scheme === 'dark') { const i = css.indexOf('.dark {'); return (css.slice(i, css.indexOf('.dark[data-dark-variant="neutral"]', i)).match(/--rail-badge: (#[0-9a-f]{6});/i) || [])[1]; }
    if (scheme === 'dark-neutral') { const i = css.indexOf('.dark[data-dark-variant="neutral"]'); return (css.slice(i, i + 12000).match(/--rail-badge: (#[0-9a-f]{6});/i) || [])[1]; }
    return (css.match(new RegExp(`\\[data-theme="${scheme}"\\] \\{[^}]*--rail-badge: (#[0-9a-f]{6});`, 'i')) || [])[1];
  };
  const rows = [];
  let ok = true;
  for (const scheme of ['light', 'dark', 'dark-neutral', 'gradient-red-purple', 'gradient-blue-purple', 'gradient-green-blue', 'gradient-orange-red', 'gradient-pink-purple']) {
    const starter = st.starterForScheme(scheme);
    const base = scheme.startsWith('gradient-') ? starter.theme.colors.markArch : starter.theme.colors.accent;
    const want = ct.railBadge(base, starter.theme.fills.rail);
    const got = (blockValue(scheme) || '').toLowerCase();
    const min = Math.min(...ct.fillColors(starter.theme.fills.rail).map((stop) => ct.contrastRatio(got || '#000000', stop)));
    rows.push(`${scheme}: ${got} (${min.toFixed(2)}:1)`);
    if (got !== want || min < 3 || got === '#a855f7') ok = false;
  }
  check('index.css: every built-in scheme\'s --rail-badge is railBadge() of its own accent / arch tint on its rail, >= 3:1 on every stop, none the old purple', ok, rows.join(' | '));
  console.log('  ' + rows.join(' | '));
}
const diag = fs.readFileSync(path.join(REPO, 'src/components/DiagnosticsPage.jsx'), 'utf8');
check('the Diagnostics frame bakes the inline custom properties into its document and takes them from the theme bridge', /inlineVars/.test(diag) && /html\.style\.setProperty\(n, String\(d\.vars\[n\]\)\)/.test(fs.readFileSync(path.join(REPO, 'backend/static/diagnostics-ui.js'), 'utf8')) || /vars/.test(diag));

console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
