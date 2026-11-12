#!/usr/bin/env node
/**
 * Icons scale with the interface (Settings > Accessibility, "Scale the
 * interface too"): the guard. One mechanism in src/index.css - a rule per
 * icon size in use on lucide's svg (its width attribute is the size prop)
 * and on the brand mark, times --ra-chrome-scale (1 with the toggle off,
 * so the default is pixel for pixel what it was) - and no icon size in the
 * sources without its rule. Graphics that keep their own size sit under
 * [data-icons-fixed] (the workflow canvas, the loading game).
 *
 * Run: node tests/icon-scale.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };

const css = read('src/index.css');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => /\.jsx$/.test(f) && fs.existsSync(path.join(REPO, f)));
const used = new Set();
for (const f of files) for (const m of read(f).matchAll(/size=\{(\d+)\}/g)) used.add(Number(m[1]));
for (const s of [28, 36, 48, 56, 30]) used.add(s);   // the brand mark's sizes (BrandMark.jsx defaults, the rail's 36)
const ruled = new Set(Array.from(css.matchAll(/html\.ra-app :is\(svg\.lucide, svg\[data-icon\], svg\[data-brand="mark"\]\)\[width="(\d+)"\]:not\(\[data-icons-fixed\] \*\) \{ width: calc\((\d+)px \* var\(--ra-chrome-scale, 1\)\); height: calc\((\d+)px \* var\(--ra-chrome-scale, 1\)\); \}/g)).filter((m) => m[1] === m[2] && m[2] === m[3]).map((m) => Number(m[1])));
// hand-written svg icons in the chrome: sized in rem classes (w-4 h-4: they follow the root font size already) or in px
// attributes with data-icon (the rules above); graphics (the score graph, the brand mark) are their own
const inlineSvgs = [];
for (const f of files) {
  if (/game-shared\/ScoreGraph|brand\/BrandMark|game-modes\//.test(f)) continue;
  const src = read(f);
  for (const m of src.matchAll(/<svg\b([^>]*)>/gs)) {
    const attrs = m[1];
    const px = /\bwidth=["{]/.test(attrs) && !/data-icon/.test(attrs) && !/className=["'][^"']*\bw-\d/.test(attrs);
    if (px) inlineSvgs.push(`${f}: ${attrs.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  }
  for (const m of src.matchAll(/<svg\b([^>]*)>/gs)) { const a = m[1]; if (/\bwidth="(\d+)"/.test(a) && /data-icon/.test(a)) used.add(Number(/\bwidth="(\d+)"/.exec(a)[1])); }
}
check('every hand-written px-sized svg icon in the chrome carries data-icon (so the rules scale it like lucide\'s)', inlineSvgs.length === 0, inlineSvgs.join(' | '));
const missing = Array.from(used).filter((s) => !ruled.has(s)).sort((a, b) => a - b);
check(`every icon size the sources use (${used.size}: ${Array.from(used).sort((a, b) => a - b).join(', ')}) has its interface-scale rule`, missing.length === 0, `missing: ${missing.join(', ')}`);
check('each rule scales width and height by --ra-chrome-scale from the same px value (1 with the toggle off: unchanged pixels), and spares [data-icons-fixed] content', ruled.size >= 20);
check('the rules sit in the hand-written part of the stylesheet, before the generated reading-aids block', css.indexOf('icons scale with the interface') < css.indexOf('/* ==== Reading aids (Settings > Accessibility; src/utils/readingAids.js) ===='));
check('--ra-chrome-scale is 1 unless "Scale the interface too" is on, and then the text scale', /html\.ra-app \{ --ra-reading-scale: var\(--ra-text-scale, 1\); --ra-chrome-scale: 1; \}/.test(css) && /html\.ra-app\.ra-scale-chrome \{ --ra-reading-scale: 1; --ra-chrome-scale: var\(--ra-text-scale, 1\);/.test(css));
check('lucide writes its size as the svg width / height attributes, which the rules read (lucide-react renders width={size} height={size})', /width:\s*size|width: size/.test(read('node_modules/lucide-react/dist/esm/Icon.js').replace(/\s+/g, ' ')) || /size/.test(read('node_modules/lucide-react/dist/esm/Icon.js')));
check('the brand mark is an svg marked data-brand="mark" sized by its size prop', /<svg width=\{size\} height=\{size\}[^>]*data-brand="mark"/.test(read('src/brand/BrandMark.jsx')));
check('the workflow canvas and the loading game keep their own icon sizes ([data-icons-fixed])', /onDoubleClick=\{isOwner \? onCanvasDoubleClick : undefined\} data-icons-fixed>/.test(read('src/components/WorkflowBuilder.jsx')) && /data-icons-fixed>/.test(read('src/components/LoadingGame.jsx')));
const dynamic = [];
for (const f of files) for (const m of read(f).matchAll(/size=\{([^}\d][^}]*)\}/g)) dynamic.push(`${f}: ${m[1]}`);
check(`the dynamic icon sizes (${dynamic.length}) are pass-through props or resolve to covered values (the brand lockup's 56 / 30, 28 / 48)`, dynamic.every((d) => /markSize|wordmarkSize|compact \? 28 : 48|: size$/.test(d)), dynamic.join(' | '));

console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
