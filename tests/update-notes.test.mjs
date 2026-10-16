/**
 * The release notes the "A new version is available" window renders
 * (src/utils/updateNotes.js) come from the network (GitHub release bodies),
 * so they must go through the sanitising Markdown path and every link must
 * open outside the app. Rendered in jsdom (npm install --no-save jsdom):
 *   - Markdown becomes HTML (headings, lists, emphasis, code);
 *   - script, event handlers, iframes, forms, images and inline styles are
 *     stripped (DOMPurify);
 *   - http(s) links get target=_blank rel=noopener noreferrer; javascript:,
 *     data: and relative links lose their href;
 *   - empty / non-string input renders nothing and never throws.
 *
 * Run:  node tests/update-notes.test.mjs
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP: jsdom is not installed (npm install --no-save jsdom)'); process.exit(0); }

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { renderNotes, UPDATE_AVAILABLE_EVENT } = await import('../src/utils/updateNotes.js');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`);
}
const render = (md) => { const div = document.createElement('div'); div.innerHTML = renderNotes(md); return div; };

const notes = `## Version 3.2.0 (2026-10-20)

### [DOCUMENTS]

- **Find in Files** got a *regex* mode, see [the guide](https://github.com/jacarium/jacarium/blob/main/docs/DEVELOPMENT.md)
- \`podman run\` now shows the setup code

<script>alert(1)</script>
<img src="https://evil.test/track.png" onerror="alert(2)">
<a href="javascript:alert(3)">click</a> <a href="/relative">rel</a> <a href="data:text/html,x">data</a>
<iframe src="https://evil.test"></iframe>
<p style="color:red" onclick="alert(4)">styled</p>
`;
const el = render(notes);
check('UPDATE_AVAILABLE_EVENT is the window event name the settings section dispatches', UPDATE_AVAILABLE_EVENT === 'showUpdateAvailable');
check('Markdown renders: h2, h3, list, strong, em, code', el.querySelector('h2')?.textContent.includes('Version 3.2.0') && el.querySelector('h3')?.textContent === '[DOCUMENTS]' && el.querySelectorAll('li').length === 2 && !!el.querySelector('strong') && !!el.querySelector('em') && el.querySelector('code')?.textContent === 'podman run');
check('script, iframe, img and inline handlers / styles are stripped', !el.querySelector('script') && !el.querySelector('iframe') && !el.querySelector('img') && !el.innerHTML.includes('onerror') && !el.innerHTML.includes('onclick') && !el.innerHTML.includes('style=') && !el.innerHTML.includes('alert('), el.innerHTML);
const links = [...el.querySelectorAll('a')];
const guide = links.find((a) => a.textContent === 'the guide');
check('an https link keeps its href and opens outside the app (target=_blank, rel=noopener noreferrer)', guide?.getAttribute('href') === 'https://github.com/jacarium/jacarium/blob/main/docs/DEVELOPMENT.md' && guide.getAttribute('target') === '_blank' && guide.getAttribute('rel') === 'noopener noreferrer');
check('javascript:, relative and data: links lose their href', links.filter((a) => a.textContent !== 'the guide').every((a) => !a.hasAttribute('href')), links.map((a) => `${a.textContent}=${a.getAttribute('href')}`).join(' '));
check('empty, null and non-string input render nothing and never throw', renderNotes('') === '' && renderNotes(null) === '' && renderNotes(undefined) === '' && typeof renderNotes(42) === 'string');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
