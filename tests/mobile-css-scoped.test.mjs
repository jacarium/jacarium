/**
 * The desktop must not change: every rule of the phone stylesheet
 * (src/mobile.css) is scoped to <html data-mobile="true">, which only the
 * phone layout sets (src/hooks/useIsMobile.js), and the phone components
 * are reached only through the MobileProvider / useMobile() gate:
 *   - every selector in src/mobile.css starts with html[data-mobile="true"]
 *     (also inside @media / @supports blocks);
 *   - src/index.css, the desktop stylesheet, mentions no data-mobile at all;
 *   - the phone components live under src/components/mobile/ and the only
 *     modules that render them conditionally consult useMobile()/isMobile;
 *   - the desktop app never sets the attribute: src/utils/mobile.js refuses
 *     when window.electronAPI.isElectron is set (checked in
 *     tests/mobile-detection.test.mjs; here the source is checked to still
 *     carry that guard).
 * Run: node tests/mobile-css-scoped.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const css = fs.readFileSync(path.join(REPO, 'src', 'mobile.css'), 'utf8');
// strip comments, then collect every selector list (the text before a '{'
// that is not an at-rule header)
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = [];
let depth = 0;
let buffer = '';
for (const ch of stripped) {
  if (ch === '{') {
    const text = buffer.trim();
    if (text && !text.startsWith('@')) selectors.push(text);
    buffer = ''; depth++;
  } else if (ch === '}') { buffer = ''; depth--; }
  else if (ch === ';' && depth > 0) { buffer = ''; }
  else buffer += ch;
}
// (a selector list splits on the commas outside parentheses: :has(a, b) is one selector)
const splitList = (list) => { const out = []; let depth = 0; let cur = ''; for (const ch of list) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()).filter(Boolean); };
const unscoped = selectors.flatMap(splitList).filter((s) => !s.startsWith('html[data-mobile="true"]'));
check(`every selector of src/mobile.css (${selectors.length} rules) is scoped to html[data-mobile="true"]`, selectors.length > 20 && unscoped.length === 0, unscoped.slice(0, 5).join(' | '));
check('src/mobile.css carries no @import and no url() (nothing loaded from elsewhere)', !/@import|url\(/.test(stripped));

const indexCss = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
check('src/index.css (the desktop stylesheet) does not mention data-mobile', !/data-mobile/.test(indexCss));

const mainJsx = fs.readFileSync(path.join(REPO, 'src', 'main.jsx'), 'utf8');
check('main.jsx loads src/mobile.css after src/index.css', mainJsx.indexOf("import './index.css'") < mainJsx.indexOf("import './mobile.css'") && mainJsx.includes("import './mobile.css'"));

const mobileJs = fs.readFileSync(path.join(REPO, 'src', 'utils', 'mobile.js'), 'utf8');
check('the gate refuses the desktop app (electronAPI.isElectron) and needs width AND a coarse pointer', /isElectron/.test(mobileJs) && /!electron && !!narrow && !!coarse/.test(mobileJs));

// The phone components: every file that renders one from outside
// src/components/mobile/ decides with useMobile()/isMobile (or is TabBar /
// ResizableSidebar, which branch on it themselves)
const srcDir = path.join(REPO, 'src');
const files = [];
(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx|js)$/.test(e.name)) files.push(p); } })(srcDir);
const offenders = [];
for (const file of files) {
  if (file.includes(`${path.sep}components${path.sep}mobile${path.sep}`)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const usesMobileComponent = /from '(\.\.?\/)+(components\/)?mobile\/(MobileBottomNav|MoreSheet|MobilePageHeader|MobileDrawer|MobileSettingsHost|MobileWorkflowView)'/.test(text);
  if (usesMobileComponent && !/useMobile\(\)|isMobile/.test(text)) offenders.push(path.relative(REPO, file));
}
check('every page that renders a phone component decides with useMobile()', offenders.length === 0, offenders.join(', '));

// The row chevron and the drawer: inert outside the phone layout
const rowMenu = fs.readFileSync(path.join(REPO, 'src', 'components', 'mobile', 'RowMenuButton.jsx'), 'utf8');
check('RowMenuButton renders nothing unless useMobile().isMobile', /if \(!isMobile[^)]*\) return null/.test(rowMenu));
const resizable = fs.readFileSync(path.join(REPO, 'src', 'components', 'ResizableSidebar.jsx'), 'utf8');
check('ResizableSidebar keeps its desktop rendering unless isMobile', /if \(isMobile\) \{/.test(resizable));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
