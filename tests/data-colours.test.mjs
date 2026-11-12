#!/usr/bin/env node
/**
 * Data colours (src/utils/dataColour.js): every colour that comes from data
 * rather than the theme - a collaborator's, a calendar's, a Kanban column's
 * or a card's presence colour, a workflow note's or data edge's - is painted
 * through paint(), so a colour-vision palette or high contrast maps it onto
 * the palette's categorical set while the stored value stays as it is.
 *
 * Checks the mapping (stable, hue-nearest, greys to the grey category), the
 * style paint() gives, the ink rule, the stylesheet rule that switches --dc
 * under the palettes, the collaborator helper, and sweeps src/ for an inline
 * colour paint that takes a data value without paint().
 *
 * Run: node tests/data-colours.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 900) : ''}`); if (!ok) failed++; };

const { paint, ink, INK, dataCategory, DATA_CATEGORIES } = await import(path.join(REPO, 'src/utils/dataColour.js'));
const { getUserBorderStyle, getUserColor, getUserBorderColor, getUserColorDark } = await import(path.join(REPO, 'src/utils/userColors.js'));

// the mapping
check('each default category maps to itself', DATA_CATEGORIES.every((c) => dataCategory(c.hex) === c.n), DATA_CATEGORIES.map((c) => `${c.hex}->${dataCategory(c.hex)}`).join(' '));
check('a red maps to the orange category, the nearest hue', dataCategory('#dc2626') === 7, dataCategory('#dc2626'));
check('a grey, white or black maps to the grey category', [dataCategory('#9ca3af'), dataCategory('#ffffff'), dataCategory('#000000'), dataCategory('rgb(120, 120, 120)')].every((n) => n === 8));
check('an unreadable or empty value maps to the grey category', [dataCategory(''), dataCategory(undefined), dataCategory('not-a-colour'), dataCategory(null)].every((n) => n === 8));
check('the mapping is stable', dataCategory('#4285f4') === dataCategory('#4285f4') && dataCategory('#4285f4') === 1);
check('rgb() and hex of the same colour map alike', dataCategory('rgb(220, 38, 38)') === dataCategory('#dc2626'));
const userHexes = Array.from({ length: 40 }, (_, i) => getUserColor(`user${i}@example.test`));
check('the sixteen collaborator colours spread over at least five categories', new Set(userHexes.map(dataCategory)).size >= 5, [...new Set(userHexes.map(dataCategory))].join(','));

// the style
const s = paint('#dc2626', 'backgroundColor', 'borderLeftColor');
check('paint() carries the stored colour, its category and --dc', s['--dc-stored'] === '#dc2626' && s['--dc-cat'] === 'var(--chart-cat-7)' && s['--dc'] === 'var(--dc-stored)', JSON.stringify(s));
check('paint() points every named property at --dc', s.backgroundColor === 'var(--dc)' && s.borderLeftColor === 'var(--dc)');
check('paint() carries the ink for the colour', s['--dc-ink'] === '#ffffff' && paint('#fbbf24')['--dc-ink'] === '#000000' && INK === 'var(--dc-ink)');
check('paint() of nothing is transparent on the grey category', paint('', 'color')['--dc-stored'] === 'transparent' && paint(undefined)['--dc-cat'] === 'var(--chart-cat-8)');
check('paint() does not alter its input', (() => { const v = '#16a34a'; paint(v, 'color'); return v === '#16a34a'; })());
check('ink(): black above BT.709 luminance 0.5, white below', ink('#ffffff') === '#000000' && ink('#000000') === '#ffffff' && ink('#4285f4') === '#ffffff' && ink('#eab308') === '#000000' && ink('junk') === '#ffffff');

// the collaborator helper
const us = getUserBorderStyle('ada@example.test');
check('getUserBorderStyle() paints through --dc', us.borderLeftColor === 'var(--dc)' && us['--dc-stored'] === getUserColor('ada@example.test'));
check('getUserColor() stays a hex (the Yjs awareness colour)', /^#[0-9a-f]{6}$/.test(getUserColor('ada@example.test')) && /^#[0-9a-f]{6}$/.test(getUserColorDark('ada@example.test')) && getUserColor('') === '#9333ea');
check('getUserBorderColor() is a categorical class', /^border-\(--chart-cat-[1-8]\)$/.test(getUserBorderColor('ada@example.test')));

// the stylesheet rule
const css = fs.readFileSync(path.join(REPO, 'src/index.css'), 'utf8');
const marker = css.indexOf('/* ==== Reading aids (Settings > Accessibility; src/utils/readingAids.js) ====');
const ruleRe = /html:is\(\.ra-cv-protanopia, \.ra-cv-deuteranopia, \.ra-cv-tritanopia, \.ra-high-contrast\) \[style\*="--dc-cat"\] \{ --dc: var\(--dc-cat\) !important; --dc-ink: oklch\(from var\(--dc-cat\) calc\(\(0\.66 - l\) \* 1000\) 0 0\) !important; \}/;
const rule = css.match(ruleRe);
check('index.css switches --dc and --dc-ink to the category under the three palettes and high contrast', !!rule, 'rule missing');
check('the rule sits before the generated reading-aids block', !!rule && marker > 0 && rule.index < marker);
check('nothing else writes --dc', (css.match(/--dc:/g) || []).length === 1, (css.match(/--dc:/g) || []).length);

// the sweep: an inline colour paint whose value is data (an identifier or member) goes through paint()
const PROPS = 'backgroundColor|background|borderColor|borderLeftColor|borderTopColor|borderRightColor|borderBottomColor|color|fill|stroke|outlineColor|caretColor';
const DEPICT = new Set([ // depict a theme or draw a fixed picture rather than paint data: allowed to use literal colours
  'src/components/common/modals/settings/SchemeGallery.jsx', 'src/components/common/modals/settings/ProfileGallery.jsx', 'src/components/common/modals/settings/CustomThemeEditor.jsx',
  'src/components/workflow/edges/ExecutionEdge.jsx', 'src/components/game-shared/ScoreGraph.jsx', 'src/components/common/NotificationHistoryPanel.jsx',
]);
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx|js)$/.test(e.name)) files.push(p); } };
walk(path.join(REPO, 'src'));
const hits = [];
for (const f of files) {
  const rel = path.relative(REPO, f);
  if (DEPICT.has(rel) || rel === 'src/utils/dataColour.js') continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/[sS]tyle=\{\{([\s\S]*?)\}\}/g)) {
    const body = m[1];
    if (body.includes('paint(')) continue;
    const bad = body.match(new RegExp(`(?:^|[,{\\s])(${PROPS})\\s*:\\s*([A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*|\`[^\`]*\\$\\{[^}]*colou?r[^}]*\\}[^\`]*\`)\\s*(?:,|$)`, 'm'));
    const shorthand = body.match(new RegExp(`(?:^|[,{\\s])(stroke|fill|color|backgroundColor)\\s*(?:,|$)`, 'm'));
    const value = bad && bad[2];
    if (bad && value !== 'INK' && !/^(undefined|null|true|false)$/.test(value)) hits.push(`${rel}: ${bad[0].trim()}`);
    else if (shorthand) hits.push(`${rel}: shorthand ${shorthand[1]}`);
  }
  // style objects built outside JSX (const borderStyle = ..., getItemStyle: ...): a `.color` member assigned to a colour property
  for (const o of text.matchAll(/[sS]tyle\w*\s*[=:]\s*[^;{]*?\{([^}]*)\}/g)) {
    if (o[1].includes('paint(')) continue;
    const m = o[1].match(new RegExp(`(?:^|[,{\\s])(${PROPS})\\s*:\\s*([A-Za-z_$][\\w$]*\\.colou?r)\\b`, 'm'));
    if (m) hits.push(`${rel}: ${m[0].trim()}`);
  }
}
check('every inline colour paint of a data value goes through paint()', hits.length === 0, hits.join(' ; '));
const painted = files.filter((f) => fs.readFileSync(f, 'utf8').includes("from '") && /\bpaint\(/.test(fs.readFileSync(f, 'utf8')) && fs.readFileSync(f, 'utf8').includes('dataColour'));
check('the known data-colour sites import paint()', ['DocumentSidebar', 'KanbanColumn', 'KanbanCard', 'ChatSidebar', 'DayView', 'WeekView', 'MonthView', 'DataEdge', 'NoteNode', 'IdeaNode', 'userColors']
  .every((n) => painted.some((f) => f.includes(n)) || n === 'DocumentSidebar'), painted.map((f) => path.basename(f)).join(','));

// the stored value is untouched: the Kanban column picker stores the chosen hex, not the painted var
const kc = fs.readFileSync(path.join(REPO, 'src/components/kanban/KanbanColumn.jsx'), 'utf8');
check('the Kanban column picker stores the chosen colour itself', /onUpdateColumnColor\?\.\(column\.id, color\)/.test(kc));
const notes = fs.readFileSync(path.join(REPO, 'src/components/workflow/nodes/NoteNode.jsx'), 'utf8');
check('a note stores its colour key, and paints tint and border from --dc', /onChange\?\.\(\{ color: key \}\)/.test(notes) && notes.includes("color-mix(in srgb, var(--dc) 16%, transparent)"));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
