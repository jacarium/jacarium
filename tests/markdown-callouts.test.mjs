#!/usr/bin/env node
/**
 * GitHub-style callouts in Documents markdown
 * (src/utils/interactiveMarkdown.js renderer.blockquote, the styles in
 * src/index.css and src/mobile.css, the editor's Insert callout menu and
 * slash entries in DocumentEditor.jsx, the PDF export in pdfExportNative.js).
 *
 *   > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
 *
 * The real pipeline in jsdom (marked + the renderer + DOMPurify): each type
 * renders a titled block of its class; the type is case-insensitive; an
 * unknown word is no marker (the quote stays a quote, text untouched); a
 * custom title with inline markdown; the fold sign (- closed, + open) makes
 * a <details>; a list, a fenced code block, a table and a nested quote
 * inside render as anywhere; a marker inside a code fence is code; a plain
 * quote is unchanged; a hostile title is sanitised. Static: the five classes,
 * their icon masks and token colours in the stylesheet (no hex), the phone
 * rules, the toolbar menu and the slash entries, the PDF forcing folds open.
 *
 * Run:  node tests/markdown-callouts.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, REPO } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('markdown-callouts', { entry: path.join(here, 'helpers', 'markdown-callouts-entry.mjs') });
const { processInteractiveMarkdown, CALLOUT_TYPES } = mod;
const { document } = window;

const render = (md) => { const div = document.createElement('div'); div.innerHTML = processInteractiveMarkdown(md); return div; };
const callouts = (root) => Array.from(root.querySelectorAll('.md-callout'));
const titleOf = (el) => el.querySelector('.md-callout-title')?.textContent.trim();
const bodyOf = (el) => el.querySelector('.md-callout-body');

console.log('\n--- 1. the five types ---');
for (const [type, label] of Object.entries(CALLOUT_TYPES)) {
  const root = render(`> [!${type.toUpperCase()}]\n> Something to say.`);
  const [c] = callouts(root);
  check(`[!${type.toUpperCase()}] renders a .md-callout-${type} titled "${label}" with an icon span and the text in its body, no blockquote left`, !!c && c.classList.contains(`md-callout-${type}`) && c.tagName === 'DIV' && c.getAttribute('role') === 'note' && c.getAttribute('aria-label') === label && c.getAttribute('data-callout') === type && titleOf(c) === label && !!c.querySelector('.md-callout-icon[aria-hidden="true"]') && bodyOf(c)?.textContent.trim() === 'Something to say.' && !root.querySelector('blockquote'), root.innerHTML.slice(0, 300));
}

console.log('\n--- 2. case, unknown types, plain quotes ---');
{
  const lower = render('> [!note]\n> lower');
  check('the type is case-insensitive ([!note] is a Note)', callouts(lower).length === 1 && callouts(lower)[0].classList.contains('md-callout-note') && titleOf(callouts(lower)[0]) === 'Note');
  const unknown = render('> [!FOO]\n> not a callout');
  check('an unknown word is no marker: the quote renders as a blockquote with its text untouched', callouts(unknown).length === 0 && !!unknown.querySelector('blockquote') && /\[!FOO\]/.test(unknown.querySelector('blockquote').textContent), unknown.innerHTML.slice(0, 200));
  const plain = render('> just a quote\n> on two lines');
  check('a plain blockquote is unchanged', callouts(plain).length === 0 && plain.querySelector('blockquote')?.textContent.trim() === 'just a quote\non two lines');
  const inline = render('Text with [!NOTE] in a paragraph');
  check('a marker outside a quote is plain text', callouts(inline).length === 0 && /\[!NOTE\]/.test(inline.textContent));
  const fenced = render('```\n> [!WARNING]\n> in a fence\n```');
  check('a marker inside a code fence is code, not a callout', callouts(fenced).length === 0 && /\[!WARNING\]/.test(fenced.querySelector('pre code')?.textContent || ''));
}

console.log('\n--- 3. titles and folds ---');
{
  const titled = render('> [!WARNING] Before you **run** it\n> Back up first.');
  const [c] = callouts(titled);
  check('a custom title follows the marker, inline markdown rendered; the body keeps the rest', !!c && titleOf(c) === 'Before you run it' && !!c.querySelector('.md-callout-title strong') && bodyOf(c).textContent.trim() === 'Back up first.', titled.innerHTML.slice(0, 300));
  const onlyTitle = render('> [!TIP] Just a title');
  check('a marker with a title and no body renders the title alone (empty body)', callouts(onlyTitle).length === 1 && titleOf(callouts(onlyTitle)[0]) === 'Just a title' && bodyOf(callouts(onlyTitle)[0]).textContent.trim() === '');
  const closed = render('> [!NOTE]- Folded\n> Hidden until opened.');
  const [d] = callouts(closed);
  check('"[!NOTE]-" is a closed <details> whose <summary> is the title', !!d && d.tagName === 'DETAILS' && !d.hasAttribute('open') && d.querySelector('summary.md-callout-title')?.textContent.trim() === 'Folded' && bodyOf(d).textContent.trim() === 'Hidden until opened.', closed.innerHTML.slice(0, 300));
  const open = render('> [!NOTE]+\n> Shown.');
  check('"[!NOTE]+" is an open <details>', callouts(open)[0]?.tagName === 'DETAILS' && callouts(open)[0].hasAttribute('open') && titleOf(callouts(open)[0]) === 'Note');
}

console.log('\n--- 4. what goes inside ---');
{
  const md = [
    '> [!IMPORTANT] Checklist',
    '> First paragraph.',
    '>',
    '> - one',
    '> - two',
    '>',
    '> ```bash',
    '> echo hi',
    '> ```',
    '>',
    '> | a | b |',
    '> |---|---|',
    '> | 1 | 2 |',
    '>',
    '> > a nested quote',
    '',
    'After.',
  ].join('\n');
  const root = render(md);
  const [c] = callouts(root);
  const b = c && bodyOf(c);
  check('a list, a fenced code block, a table and a nested quote inside the callout render as anywhere (the body is the quote\'s own tokens)', !!b && b.querySelectorAll('li').length === 2 && !!b.querySelector('pre code') && b.querySelectorAll('td').length === 2 && !!b.querySelector('blockquote') && b.querySelector('p')?.textContent === 'First paragraph.' && root.textContent.includes('After.'), root.innerHTML.slice(0, 400));
  check('the paragraph after the callout is outside it', !c.contains(Array.from(root.querySelectorAll('p')).find((p) => p.textContent === 'After.')));
  const two = render('> [!TIP]\n> one\n\n> [!CAUTION]\n> two');
  check('two callouts in a row are two blocks', callouts(two).map((x) => x.getAttribute('data-callout')).join() === 'tip,caution');
}

console.log('\n--- 5. sanitising ---');
{
  const hostile = render('> [!NOTE] <img src=x onerror=alert(1)> title\n> <script>alert(2)</script> body');
  const [c] = callouts(hostile);
  check('a hostile title and body are sanitised like any other text (no onerror, no script)', !!c && !hostile.querySelector('[onerror]') && !hostile.querySelector('script') && !/onerror|<script/i.test(hostile.innerHTML), hostile.innerHTML.slice(0, 300));
  check('the output uses only what DOMPurify keeps: class, role, aria-label, data-callout, open survive', !!c.getAttribute('role') && !!c.getAttribute('aria-label') && callouts(render('> [!NOTE]+\n> x'))[0].hasAttribute('open'));
}

console.log('\n--- 6. static: the styles, the phone, the editor, the PDF ---');
{
  const css = fs.readFileSync(path.join(REPO, 'src', 'index.css'), 'utf8');
  const start = css.indexOf('/* GitHub-style callouts');
  const end = css.indexOf('.pdf-export-root details.md-callout', start);
  const block = start >= 0 && end > start ? css.slice(start, end) : '';
  check('index.css styles the five types on the theme tokens (blue, success, code-keyword, terminal-warning, terminal-error)', /\.md-callout \{[\s\S]*--os-blue/.test(block) && /md-callout-tip[^}]*--os-status-success/.test(block) && /md-callout-important[^}]*--os-code-keyword/.test(block) && /md-callout-warning[^}]*--os-terminal-warning/.test(block) && /md-callout-caution[^}]*--os-terminal-error/.test(block));
  const noUrls = block.replace(/url\("[^"]*"\)/g, '');
  const uris = [...new Set(block.match(/url\("data:image\/svg\+xml[^"]*"\)/g) || [])];
  check('...with no hex colour of its own (the five icon masks and the fold chevron are the only data URIs)', !/#[0-9a-fA-F]{3,8}\b/.test(noUrls) && uris.length === 6, `${uris.length} uris; ${(noUrls.match(/#[0-9a-fA-F]{3,8}\b/g) || []).join(',')}`);
  check('every icon is a lucide frame: 24x24, 2px stroke, round caps and joins, no fill', uris.every((u) => /viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/.test(u)));
  const mobile = fs.readFileSync(path.join(REPO, 'src', 'mobile.css'), 'utf8');
  check('the phone has its own callout rules (padding, title size, 18px icon), all scoped', /html\[data-mobile="true"\] \.markdown-preview \.md-callout \{/.test(mobile) && /\.md-callout-icon \{ width: 18px; height: 18px; \}/.test(mobile));
  const editor = fs.readFileSync(path.join(REPO, 'src', 'components', 'features', 'documents', 'DocumentEditor.jsx'), 'utf8');
  check('the toolbar offers the five callouts in its Insert menu (and the phone\'s More menu) with their lucide icons (Info, Lightbulb, MessageSquareWarning, TriangleAlert, OctagonAlert)', /const CALLOUT_ICONS = \{ note: Info, tip: Lightbulb, important: MessageSquareWarning, warning: TriangleAlert, caution: OctagonAlert \};/.test(editor) && /const calloutItems = CALLOUT_TYPES\.map\(\(c\) => \(\{ id: `callout-\$\{c\.type\}`, Icon: CALLOUT_ICONS\[c\.type\], label: c\.label, onSelect: \(\) => insertCallout\(c\.type\) \}\)\);/.test(editor) && /\{ heading: 'Callouts' \}, \.\.\.calloutItems,/.test(editor) && /testId="insert-menu"/.test(editor) && /testId="more-menu"/.test(editor));
  const calloutsModule = await import(path.join(REPO, 'src', 'utils', 'callouts.js'));
  check('the slash menu offers /note ... /caution as built-in entries (src/utils/callouts.js) that insert the marker', /\[\.\.\.BUILTIN_COMMANDS, \.\.\.documentTemplates\]/.test(fs.readFileSync(path.join(REPO, 'src', 'components', 'DocumentsPage.jsx'), 'utf8')) && calloutsModule.CALLOUT_COMMANDS.map((c) => c.name).join() === '/note,/tip,/important,/warning,/caution' && calloutsModule.CALLOUT_COMMANDS[3].content === '> [!WARNING]\n> ');
  check('insertCallout quotes every selected line under the marker, on its own paragraph', /const insertCallout = \(type\) =>/.test(editor) && /\.split\('\\n'\)\.map\(\(line\) => `> \$\{line\}`\)/.test(editor));
  const pdf = fs.readFileSync(path.join(REPO, 'src', 'utils', 'pdfExportNative.js'), 'utf8');
  check('a callout prints its colours (print-color-adjust: exact) and does not split across pages (break-inside: avoid)', /print-color-adjust: exact;\n  break-inside: avoid;/.test(block));
  check('the PDF export forces folded callouts open before printing', /querySelectorAll\('details\.md-callout'\)\) folded\.open = true/.test(pdf) && /\.pdf-export-root details\.md-callout > summary\.md-callout-title::after \{ display: none; \}/.test(css));
}

process.exit(summary());
