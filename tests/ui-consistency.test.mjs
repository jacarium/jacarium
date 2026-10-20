/**
 * The unified look, swept over every component (lint-style, espree AST):
 *
 *  - no <button>/<Button> carries a weight class (font-bold/semibold/medium)
 *    or a one-off radius class (rounded, rounded-none/xs/md/lg/xl/2xl/3xl):
 *    the base rules give the control radius and the normal weight;
 *    rounded-sm (the control radius itself), rounded-full (pills) and the
 *    partial corners (rounded-t-*) are allowed;
 *  - the same for <input>, <select>, <textarea> and the field primitives,
 *    and no weight class on <label>;
 *  - text buttons carry no lucide icons. Functional icons stay: disclosure
 *    chevrons, selection checks, show/hide eyes, close, spinners; list rows
 *    (text-left), menu items, options, tree items and tabs keep theirs;
 *    tooltip-like children (sr-only, opacity-0, absolute ...) do not count
 *    as text;
 *  - an underline tab (a button whose className has border-b-2, the active
 *    tab's indicator) is square: rounded-none, as SubTabs in
 *    src/components/ui/primitives.jsx - the button base radius would curve
 *    the underline's ends into a pill (the Media Library's Browse / Upload
 *    once did); dialogs and panels use SubTabs rather than restyling;
 *  - no raw hex colour and no Tailwind grey class (gray/slate/zinc ...) in a
 *    component's className outside the allow-list (charts, syntax
 *    highlighting, Mermaid, the games, the node palette): the --os-* tokens
 *    carry the neutrals in both themes.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
let espree; try { espree = req('espree'); } catch { console.log('SKIP: espree (eslint) missing - npm install'); process.exit(0); }
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 600) : ''}`); if (!ok) failed++; };

// justified exceptions: the primitives themselves, the games and tiles (their own visual language), charts and highlighting
const ALLOW = /src\/components\/ui\/|LoadingGame|FloatingTiles|game-modes\/|charts?\/|codeHighlight|mermaid/i;
// colours: the games and tiles, the workflow node palette, the OpenShift masthead imitation, charts and highlighting keep their own;
// FloatingDraft's paper palettes are a feature
const HEX_ALLOW = /LoadingGame|FloatingTiles|game-modes\/|charts?\/|codeHighlight|mermaid|brand\/|OpenShiftMasthead|calendars\/|workflow\/nodes|StartupError|diagnostics|FloatingDraft/i;
const GREY_ALLOW = /LoadingGame|FloatingTiles|game-modes\/|charts?\/|codeHighlight|mermaid|OpenShiftMasthead|workflow\/nodes|FloatingDraft/i;
const GREY = /(?<![\w-])(?:(?:dark|hover|group-hover|focus):)*(?:bg|text|border|divide|placeholder|ring)-(?:gray|slate|zinc|neutral|stone)-\d{2,3}(?:\/\d+)?(?![\w-])/;
const files = execFileSync('git', ['ls-files', 'src'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => /\.jsx$/.test(f) && !ALLOW.test(f));
const WEIGHT = /(?<![\w-])(?:(?:hover|focus|group-hover|dark|sm|md|lg|focus-visible|active|disabled):)*font-(?:bold|semibold|medium)(?![\w-])/;
const RADIUS = /(?<![\w-])(?:(?:hover|focus|dark|sm|md|lg):)*rounded(?:-(?:xs|md|lg|xl|2xl|3xl))?(?![\w-])/;   // rounded-none (square rows, tab strips) and rounded-sm (the control radius) are allowed
const KEEP_ICON = /^(Chevron\w*|Check|CheckSquare|Square|Eye|EyeOff|X|GripVertical|CaretDown|CaretRight)$/;
// tooltip-like children do not count as text; a responsive label ("hidden sm:inline") does
const TOOLTIPISH = (attrs) => /sr-only|opacity-0|pointer-events-none|absolute/.test(attrs) || (/(?<![\w-])hidden(?![\w-])/.test(attrs) && !/\w+:(inline|block|flex)/.test(attrs));
// list rows keep their icons: a left-aligned button with block children (title + subtitle) or an option/tree item;
// a single-line left-aligned button is a menu item and is text only. The OpenShift tool's navigation keeps its icons.
const ROW_LIKE = (attrs, node, src) => /role="(option|treeitem)"/.test(attrs) || (/text-left/.test(attrs) && hasBlockChildren(node));
function hasBlockChildren(node) { let found = false; walk(node, (n) => { if (n !== node && n.type === 'JSXElement' && /^(div|p|h[1-6]|ul|li|table)$/.test(tagName(n.openingElement.name))) found = true; }); return found; }
const CONTROLS = new Set(['button', 'input', 'select', 'textarea']);
const PRIMITIVES = /^(Button|IconButton|TextInput|Input|PasswordInput|Select|TextArea|NumberInput|SearchInput)$/;

const tagName = (n) => (n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${tagName(n.object)}.${n.property.name}` : '');
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, node));
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}
const classStrings = (attr, src) => {
  const out = []; const v = attr.value; if (!v) return out;
  if (v.type === 'Literal') out.push(String(v.value));
  else if (v.type === 'JSXExpressionContainer') walk(v.expression, (n) => { if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value); else if (n.type === 'TemplateElement') out.push(n.value.cooked || src.slice(n.range[0], n.range[1])); });
  return out;
};
const attrText = (el, src) => src.slice(el.openingElement.range[0], el.openingElement.range[1]);

const weightOnControls = [], radiusOnControls = [], weightOnLabels = [], iconsInTextButtons = [], emptyButtons = [], hexColours = [], greys = [], roundedTabs = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(REPO, f), 'utf8');
  let ast; try { ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true, loc: true }); } catch (e) { check(`${f} parses`, false, e.message); continue; }
  const lucide = new Set((src.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/) || [, ''])[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const parents = new Map(); walk(ast, (n, p) => parents.set(n, p));
  walk(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    const name = tagName(node.openingElement.name); const line = node.loc.start.line;
    const isControl = CONTROLS.has(name) || PRIMITIVES.test(name);
    for (const a of node.openingElement.attributes) {
      if (a.type !== 'JSXAttribute') continue;
      if (a.name.name === 'className') {
        const strs = classStrings(a, src);
        if (isControl) { for (const s of strs) { if (WEIGHT.test(s)) weightOnControls.push(`${f}:${line} <${name}> ${s.match(WEIGHT)[0]}`); if (RADIUS.test(s)) radiusOnControls.push(`${f}:${line} <${name}> ${s.match(RADIUS)[0]}`); } }
        if (name === 'label') for (const s of strs) if (WEIGHT.test(s)) weightOnLabels.push(`${f}:${line} ${s.match(WEIGHT)[0]}`);
        if ((name === 'button' || name === 'Button') && /(?<![\w-])border-b-2(?![\w-])/.test(strs.join(' ')) && !/(?<![\w-])rounded-none(?![\w-])/.test(strs.join(' '))) roundedTabs.push(`${f}:${line} <${name}>`);
        if (!HEX_ALLOW.test(f)) for (const s of strs) { const m = s.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/); if (m) hexColours.push(`${f}:${line} ${m[0]}`); }
        if (!GREY_ALLOW.test(f)) for (const s of strs) { const m = s.match(GREY); if (m) greys.push(`${f}:${line} ${m[0]}`); }
      }
    }
    if ((name === 'button' || name === 'Button') && lucide.size && !ROW_LIKE(attrText(node, src), node, src) && !/OpenShiftSidebar/.test(f)) {
      const attrsEnd = node.openingElement.range[1];
      const skipSet = new Set(); walk(node, (n) => { if (n !== node && n.type === 'JSXElement' && TOOLTIPISH(attrText(n, src))) skipSet.add(n); });
      const inSkipped = (n) => { let q = parents.get(n); while (q && q !== node) { if (skipSet.has(q)) return true; q = parents.get(q); } return false; };
      // A string inside ANY attribute of a child (`className={busy ? 'animate-spin' : ''}`,
      // a template className, `title={done ? 'Mark as not done' : 'Mark as done'}`) is
      // not visible text. An earlier revision only excluded strings whose DIRECT parent
      // was the attribute, so an icon whose className was a conditional counted as
      // "icon next to text" - and the clean-ups that followed this check emptied
      // three icon-only buttons (the task's done checkbox among them).
      const inAttribute = (n) => { let q = parents.get(n); while (q && q !== node) { if (q.type === 'JSXAttribute') return true; q = parents.get(q); } return false; };
      let text = false; const icons = [];
      walk(node, (n) => {
        if (n === node || n.range[1] <= attrsEnd || inSkipped(n)) return;
        if (n.type === 'JSXText' && /[A-Za-z]{2,}/.test(n.value)) text = true;
        else if (n.type === 'Literal' && typeof n.value === 'string' && /[A-Za-z]{2,}/.test(n.value) && !inAttribute(n)) text = true;
        else if (n.type === 'TemplateElement' && /[A-Za-z]{2,}/.test(n.value.cooked || '') && !inAttribute(n)) text = true;
        else if (n.type === 'JSXExpressionContainer' && !inAttribute(n) && n.expression.type === 'Identifier' && /^(label|title|children|text|name|caption|buttonText|actionLabel|confirmLabel|cancelLabel)$/.test(n.expression.name)) text = true;
        else if (n.type === 'JSXElement' && lucide.has(tagName(n.openingElement.name)) && !KEEP_ICON.test(tagName(n.openingElement.name)) ) icons.push(tagName(n.openingElement.name));
      });
      if (text && icons.length) iconsInTextButtons.push(`${f}:${line} <${name}> ${icons.join(',')}`);
    }
    // A button with nothing inside it renders as an invisible click target
    // (what the emptied icon-only buttons looked like): whitespace and
    // comments only, no element, expression or text.
    if ((name === 'button' || name === 'Button') && node.closingElement) {
      const real = node.children.filter((c) => !(c.type === 'JSXText' && !c.value.trim()) && !(c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression'));
      if (!real.length) emptyButtons.push(`${f}:${line} <${name}>`);
    }
  });
}
check(`no weight class on buttons and fields (${files.length} components)`, weightOnControls.length === 0, weightOnControls.slice(0, 8).join(' ; '));
check('no one-off radius class on buttons and fields', radiusOnControls.length === 0, radiusOnControls.slice(0, 8).join(' ; '));
check('no weight class on labels', weightOnLabels.length === 0, weightOnLabels.slice(0, 8).join(' ; '));
check('no icon in a text button', iconsInTextButtons.length === 0, iconsInTextButtons.slice(0, 8).join(' ; '));
check('no empty button (an icon-only button shows its icon)', emptyButtons.length === 0, emptyButtons.slice(0, 8).join(' ; '));
check('no underline tab with a radius: a button with border-b-2 carries rounded-none (use SubTabs from src/components/ui/primitives.jsx)', roundedTabs.length === 0, roundedTabs.slice(0, 8).join(' ; '));
check('no raw hex colour in a component className outside the allow-list', hexColours.length === 0, hexColours.slice(0, 8).join(' ; '));
check('no Tailwind grey class in a component className outside the allow-list (the --os-* tokens carry the neutrals)', greys.length === 0, greys.slice(0, 10).join(' ; '));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
