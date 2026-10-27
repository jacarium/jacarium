#!/usr/bin/env node
/**
 * marked 18 and the sanitising that follows it everywhere in the app.
 *
 * marked 17 -> 18 changed one thing in what it emits for our Markdown: block tokens lose their trailing blank
 * lines, so a raw HTML block (or a <script> block) is followed DIRECTLY by the next element - `</div><p>text</p>`
 * where 17 emitted `</div>\n<p>text</p>\n` (measured over a corpus of headings, fences, tables, callouts, lists,
 * raw and inline HTML, links, images, entities, breaks: nothing else moved). Every call site runs the output
 * through DOMPurify (FloatingDraft, DraftSidebar, AIMessageMarkdown, gtfobins CodeBlock / ExecutableDetail,
 * interactiveMarkdown, updateNotes) or shows it as text (MarkdownPreviewTool), so the shape change must not
 * open anything: this renders the hostile inputs through marked 18 and the same DOMPurify call the components
 * make, and through src/utils/updateNotes.js's renderNotes() as it is.
 *
 *  - a raw HTML block followed by text: the text stays a paragraph, the block's handlers / scripts are gone;
 *  - a <script> block followed by text: the script is gone, the text stays;
 *  - inline <img onerror>, javascript: links, <iframe>, <svg onload>: stripped;
 *  - renderNotes(): no images, links open outside (target/rel), javascript: href dropped;
 *  - a fenced block ending in blank lines keeps its code (the trim is of block separators, not code);
 *  - the installed marked is 18.x, the locked version.
 *
 * jsdom supplies the window DOMPurify needs (SKIPs without it). Run: node tests/marked-sanitised-html.test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(REPO, 'package.json'));
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP: jsdom missing (npm install --no-save jsdom)'); process.exit(0); }
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { marked } = require('marked');
const DOMPurify = require('dompurify')(dom.window);
const version = require('marked/package.json').version;
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')).packages['node_modules/marked'].version;
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };
const render = (md) => DOMPurify.sanitize(marked(md));   // what FloatingDraft / DraftSidebar / gtfobins / AIMessageMarkdown do

check(`the installed marked (${version}) is the locked one (${lock}) and is 18.x`, version === lock && /^18\./.test(version));

let html = render('<div class="x" onclick="alert(1)">\n<b>bold</b>\n</div>\n\ntext after\n');
check('a raw HTML block directly followed by text (the 18 shape): the paragraph survives, the handler does not',
      html.includes('<p>text after</p>') && html.includes('<b>bold</b>') && !/onclick/i.test(html), html);
html = render('<script>alert(1)</script>\n\ntext after\n');
check('a <script> block followed by text: the script is gone, the text stays a paragraph', !/<script/i.test(html) && !/alert\(1\)/.test(html) && html.includes('<p>text after</p>'), html);
html = render('a <img src=x onerror=alert(1)> and [j](javascript:alert(1)) and <iframe src="https://example.invalid"></iframe> and <svg onload=alert(1)></svg>');
check('inline img onerror, javascript: link, iframe and svg onload are stripped', !/onerror|javascript:|<iframe|onload/i.test(html) && html.includes('<img src="x">') && html.includes('<a>j</a>'), html);
html = render('| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | `ok` |\n');
check('a GFM table cell with an injected handler is sanitised, the table stays a table', html.includes('<table>') && html.includes('<code>ok</code>') && !/onerror/i.test(html), html);
html = render('```bash\necho hi\n\n\n```\n\nafter\n');
check('a fenced block ending in blank lines keeps its code and class; "after" is its own paragraph',
      /<pre><code class="language-bash">echo hi\n/.test(html) && html.includes('<p>after</p>'), html);
html = render('> [!NOTE]\n> body <img src=x onerror=alert(1)>\n\ntext\n');
check('a blockquote (the callout syntax) is sanitised like the rest', html.includes('<blockquote>') && !/onerror/i.test(html) && html.includes('<p>text</p>'), html);

// renderNotes() as the What's New window uses it on notes that arrive from the network
const { renderNotes } = await import(path.join(REPO, 'src', 'utils', 'updateNotes.js'));
html = renderNotes('## 3.4.9\n\n<div>\n<img src="https://example.invalid/t.png">\n</div>\n\n- [site](https://example.com) and [bad](javascript:alert(1))\n\n<script>alert(2)</script>\n\nmore\n');
check('renderNotes: no <img>, no <script>, links open outside (target _blank, rel noopener), javascript: href dropped, the text after the blocks kept',
      !/<img|<script|alert\(/i.test(html) && /<a [^>]*href="https:\/\/example\.com"[^>]*target="_blank"[^>]*>site<\/a>|<a [^>]*target="_blank"[^>]*href="https:\/\/example\.com"[^>]*>site<\/a>/.test(html)
      && /rel="[^"]*noopener/.test(html) && !/href="javascript:/.test(html) && html.includes('<p>more</p>'), html);

console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
