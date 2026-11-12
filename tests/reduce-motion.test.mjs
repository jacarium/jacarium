#!/usr/bin/env node
/**
 * Reduce motion (Settings > Accessibility > Everywhere): the model and the
 * guard. One switch - the ra-reduce-motion class on <html> - set by
 * readingAids.js from the setting (Follow system / On / Off) and the OS
 * query; the stylesheet keys every animation and transition on that class
 * through one blanket rule and never on a prefers-reduced-motion media
 * query (so Off keeps the motion when the OS asks for less); scripts ask
 * scrollBehavior() before a smooth scroll; the Diagnostics frame turns
 * Chart.js's animation off; the Calm and Focus profiles reduce motion; a
 * Reading shortcut (unbound) flips what is in effect. The default look is
 * unchanged.
 *
 * Run: node tests/reduce-motion.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };

const RA = await import(path.join(REPO, 'src/utils/readingAids.js'));
const P = await import(path.join(REPO, 'src/utils/readingAidProfiles.js'));
const R = await import(path.join(REPO, 'src/shortcuts/registry.js'));
const d = RA.DEFAULT_READING_AIDS;

console.log('--- 1. the model ---');
check('1. three values - Follow system, On, Off - Follow system by default, an app-wide option; junk falls back to Follow system',
  RA.REDUCE_MOTIONS.join() === 'system,on,off' && d.reduceMotion === 'system' && RA.OPTION_SCOPE.reduceMotion === 'app'
  && RA.normalizeReadingAids({ reduceMotion: 'sometimes' }).reduceMotion === 'system' && RA.normalizeReadingAids({ reduceMotion: true }).reduceMotion === 'system'
  && RA.normalizeReadingAids({ reduceMotion: 'off' }).reduceMotion === 'off');
check('1. what is in effect: On reduces whatever the OS says, Off never does, Follow system follows the OS',
  RA.reducesMotion({ reduceMotion: 'on' }, false) === true && RA.reducesMotion({ reduceMotion: 'on' }, true) === true
  && RA.reducesMotion({ reduceMotion: 'off' }, true) === false && RA.reducesMotion({ reduceMotion: 'off' }, false) === false
  && RA.reducesMotion({ reduceMotion: 'system' }, true) === true && RA.reducesMotion({ reduceMotion: 'system' }, false) === false);
check('1. the OS query: false without matchMedia (Node, SSR), the media query\'s answer with it',
  RA.systemReducesMotion(null) === false && RA.systemReducesMotion({}) === false
  && RA.systemReducesMotion({ matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) }) === true
  && RA.systemReducesMotion({ matchMedia: () => ({ matches: false }) }) === false
  && RA.systemReducesMotion({ matchMedia: () => { throw new Error('no'); } }) === false);
check('1. the switch is one class on <html>, ra-reduce-motion: the defaults carry none (today\'s look) while the OS does not ask, Follow system adds it when the OS asks, On always, Off never',
  RA.readingAidsClasses(d, 'app', { systemReducedMotion: false }).join() === 'ra-app'
  && RA.readingAidsClasses(d, 'app', { systemReducedMotion: true }).join() === 'ra-app,ra-reduce-motion'
  && RA.readingAidsClasses({ reduceMotion: 'on' }, 'app', { systemReducedMotion: false }).includes('ra-reduce-motion')
  && !RA.readingAidsClasses({ reduceMotion: 'off' }, 'app', { systemReducedMotion: true }).includes('ra-reduce-motion')
  && !RA.readingAidsClasses({ reduceMotion: 'on' }, 'documents').includes('ra-reduce-motion')
  && Object.keys(RA.readingAidsVars({ reduceMotion: 'on' }, 'all')).length === 0, RA.readingAidsClasses(d, 'app', { systemReducedMotion: true }).join());
const fakeRoot = (on) => ({ classList: { contains: (c) => on && c === 'ra-reduce-motion' } });
check('1. scrollBehavior(): "auto" while motion is reduced, "smooth" otherwise, "smooth" without a document',
  RA.scrollBehavior(fakeRoot(true)) === 'auto' && RA.scrollBehavior(fakeRoot(false)) === 'smooth' && RA.scrollBehavior(null) === 'smooth');
check('1. the stored settings: On is stored, Follow system (the default) is not', (() => {
  const mem = new Map(); const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  RA.saveReadingAids({ reduceMotion: 'on' }, store);
  const stored = JSON.parse(mem.get(RA.READING_AIDS_KEY));
  RA.saveReadingAids({ reduceMotion: 'system' }, store);
  return stored.reduceMotion === 'on' && !mem.has(RA.READING_AIDS_KEY);
})());

console.log('\n--- 2. the profiles and the shortcut ---');
check('2. Calm and Focus reduce motion; the other profiles leave it at Follow system',
  P.profileSettings('calm').reduceMotion === 'on' && P.profileSettings('focus').reduceMotion === 'on'
  && ['default', 'comfortable', 'dyslexia', 'lowVision', 'cvRed', 'cvGreen', 'cvBlue'].every((id) => P.profileSettings(id).reduceMotion === 'system'));
const action = R.ACTIONS.find((a) => a.id === 'reading.reduceMotion');
check('2. a Reading shortcut "Reduce motion", unbound by default, bindable, the renderer\'s, global; the desktop twin lists it',
  !!action && action.label === 'Reduce motion' && action.group === 'reading' && action.owner === 'renderer' && action.scope === 'global'
  && R.defaultChord(action, 'mac') === null && R.defaultChord(action, 'other') === null && /reading\.reduceMotion/.test(read('electron/shortcuts-registry.cjs')));
check('2. the handler flips what is in effect (Follow system with the OS asking counts as on): on -> Off, otherwise -> On',
  /useShortcut\('reading\.reduceMotion', \(\) => \{ saveReadingAids\(\{ reduceMotion: reducesMotion\(loadReadingAids\(\)\) \? 'off' : 'on' \}\); return true; \}\)/.test(read('src/components/JQLBuilder.jsx')));

console.log('\n--- 3. the stylesheet: one blanket rule on the switch, no media query ---');
const css = read('src/index.css');
check('3. no prefers-reduced-motion media query in the stylesheet (the switch decides; Off wins over the OS)', !/prefers-reduced-motion/.test(css));
check('3. the blanket rule: under html.ra-reduce-motion every element, ::before and ::after ends its animations at once (0.01ms, one iteration, no delay - animationend still fires), runs no transition at all (0s: a property change is instant and a style read straight after sees it; nothing waits on transitionend) and scrolls without smoothing',
  /html\.ra-reduce-motion \*, html\.ra-reduce-motion \*::before, html\.ra-reduce-motion \*::after \{\s*animation-duration: 0\.01ms !important; animation-iteration-count: 1 !important; animation-delay: 0ms !important;\s*transition-duration: 0s !important; transition-delay: 0s !important;\s*scroll-behavior: auto !important;\s*\}/.test(css));
check('3. the shared panel motion (one place): none by design - 0 ms, no keyframes, the two classes read the tokens - and the switch zeroes the duration and removes the animation as well',
  /html\.ra-reduce-motion \{ --motion-panel-duration: 0ms; \}/.test(css)
  && /html\.ra-reduce-motion :is\(\.sc-slide-in-left, \.sc-slide-in-right\) \{ animation: none; \}/.test(css)
  && /:root \{ --motion-panel-duration: 0ms; --motion-panel-ease: cubic-bezier\(0\.2, 0, 0, 1\); --motion-panel-left: none; --motion-panel-right: none; \}/.test(css)
  && /\.sc-slide-in-left \{ animation: var\(--motion-panel-left\) var\(--motion-panel-duration\) var\(--motion-panel-ease\); \}/.test(css)
  && /\.sc-slide-in-right \{ animation: var\(--motion-panel-right\) var\(--motion-panel-duration\) var\(--motion-panel-ease\); \}/.test(css)
  && !/@keyframes sc-slide-in/.test(css));
check('3. the rule lives in the generated reading-aids block (after its marker), with the other ra-* rules',
  css.indexOf('html.ra-reduce-motion *, html.ra-reduce-motion *::before') > css.indexOf('/* ==== Reading aids (Settings > Accessibility; src/utils/readingAids.js) ===='));

console.log('\n--- 4. the sweep of the sources ---');
const files = execFileSync('git', ['ls-files', 'src', 'index.html'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => /\.(jsx?|css|html)$/.test(f));
const offenders = { media: [], variants: [], smooth: [] };
for (const f of files) {
  const src = read(f);
  if (/prefers-reduced-motion/.test(src) && f !== 'src/utils/readingAids.js' && f !== 'src/components/common/ReadingAidsSurface.jsx') offenders.media.push(f);   // only the switch reads the query
  if (/\bmotion-(safe|reduce):/.test(src)) offenders.variants.push(f);
  if (/behavior:\s*['"]smooth['"]/.test(src)) offenders.smooth.push(f);
}
check('4. no source file keys anything on prefers-reduced-motion except the switch (readingAids.js reads the query, the surface hook follows its changes)', offenders.media.length === 0, offenders.media.join());
check('4. no Tailwind motion-safe: / motion-reduce: variant (they would follow the OS, not the setting)', offenders.variants.length === 0, offenders.variants.join());
check('4. every smooth scroll asks scrollBehavior() (a script option would override the stylesheet)', offenders.smooth.length === 0, offenders.smooth.join());
const smoothUsers = files.filter((f) => /scrollBehavior\(\)/.test(read(f)));
const importsHelper = (f) => { const m = /import \{[^}]*\bscrollBehavior\b[^}]*\} from '([^']+)'/.exec(read(f)); return !!m && fs.existsSync(path.resolve(REPO, path.dirname(f), m[1] + '.js')) && path.basename(m[1]) === 'readingAids'; };   // the path resolves (a wrong depth is a blank page, not a lint error)
check('4. ...and the chat panes, the AI chat page, the mobile workflow view and the SSH completion list do, importing the helper from readingAids by a path that resolves', ['src/components/AIChatPage.jsx', 'src/components/common/AIChatSidebar.jsx', 'src/components/common/ChatSidebar.jsx', 'src/components/mobile/MobileWorkflowView.jsx', 'src/components/workflow/ssh/SSHCompletionList.jsx'].every((f) => smoothUsers.includes(f) && importsHelper(f)), smoothUsers.map((f) => `${f}:${importsHelper(f)}`).join());
const diag = read('src/components/DiagnosticsPage.jsx');
check('4. the Diagnostics frame: Chart.js draws without animation while the frame\'s <html> carries the switch (the parent mirrors its ra-* classes there), its own default back when not - the defaults and every drawn chart',
  /var still = document\.documentElement\.classList\.contains\('ra-reduce-motion'\);/.test(diag) && /Chart\.defaults\.animation = still \? false : chartAnimation;/.test(diag) && /o\.animation = still \? false : chartAnimation;/.test(diag));
const surface = read('src/components/common/ReadingAidsSurface.jsx');
check('4. Follow system is live: the surface hook listens to the media query\'s change event and re-applies the classes', /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(surface) && /mq\.addEventListener\('change', onChange\)/.test(surface) && /\[settings, systemMotion\]/.test(surface));
const settings = read('src/components/common/modals/settings/AccessibilitySettings.jsx');
check('4. Settings > Accessibility, the Everywhere group: a Reduce motion control with Follow system / On / Off (a Segmented, data-testid ra-reduce-motion)',
  /<Segmented value=\{settings\.reduceMotion\} onChange=\{\(reduceMotion\) => set\(\{ reduceMotion \}\)\} testId="ra-reduce-motion" options=\{\[\{ id: 'system', label: 'Follow system' \}, \{ id: 'on', label: 'On' \}, \{ id: 'off', label: 'Off' \}\]\} \/>/.test(settings)
  && settings.indexOf('testId="ra-reduce-motion"') < settings.indexOf('<Group scope="reading"'));

console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
