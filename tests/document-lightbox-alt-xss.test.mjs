/**
 * Guards the stored-XSS fix in the DocumentEditor image lightbox
 * (src/components/features/documents/DocumentEditor.jsx).
 *
 * THE BUG: clicking an image in a rendered document opened a lightbox whose
 * caption was built with
 *     info.innerHTML = `<p class="text-sm font-medium">${img.alt}</p>`;
 * DOMPurify keeps the `alt` attribute verbatim (it is plain text as an
 * attribute), but this re-injected it as HTML markup. Documents are synced
 * from other machines, so an alt text such as
 *     <img src=x onerror="...">
 * became script execution in the privileged renderer the moment the
 * recipient clicked the image.
 *
 * THE FIX: the caption is built with document.createElement('p') +
 * textContent, which cannot create elements. Same classes, same visual
 * output for legitimate alt text.
 *
 * What this test proves:
 *   - source scan: the lightbox block no longer contains an innerHTML sink
 *     with `${img.alt}` and does use textContent for the caption;
 *   - jsdom reproduction of the exact sink shape: the OLD pattern turns a
 *     malicious alt into a real <img onerror> element inside the caption
 *     (demonstrating the bug class), the NEW pattern yields a single <p>
 *     with the alt as literal text, no child elements, and the rendered
 *     text is byte-for-byte the alt value;
 *   - legitimate alt text renders identically with the required classes.
 *
 * Run:  node tests/document-lightbox-alt-xss.test.mjs
 * Preconditions: jsdom (test-only dep, not in package.json):
 *                npm install --no-save jsdom fake-indexeddb
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const req = createRequire(path.join(REPO, 'package.json'));

let JSDOM;
try {
  ({ JSDOM } = req('jsdom'));
} catch {
  console.error('Missing dependency "jsdom". Run: npm install --no-save jsdom fake-indexeddb');
  process.exit(1);
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

// ---------- source scan ----------
const src = fs.readFileSync(path.join(REPO, 'src/components/features/documents/DocumentEditor.jsx'), 'utf8');
const start = src.indexOf('// Add image info if available');
const end = src.indexOf('lightbox.appendChild(closeBtn)', start);
// Comments stripped: the fixed block deliberately documents why innerHTML is banned.
const block = start >= 0 && end > start
  ? src.slice(start, end).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  : '';
check('lightbox caption block found', block.length > 0);
check('no innerHTML sink with img.alt in the lightbox block', block.length > 0 && !/innerHTML[\s\S]*img\.alt/.test(block));
check('caption uses textContent', /caption\.textContent\s*=\s*img\.alt/.test(block));
check('caption keeps the original classes', /caption\.className\s*=\s*'text-sm font-medium'/.test(block));
check('no template-literal HTML built from img.alt anywhere in the file', !/`[^`]*\$\{img\.alt\}[^`]*`/.test(src));

// ---------- jsdom reproduction ----------
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const { document } = dom.window;
const MALICIOUS_ALT = '<img src=x onerror="window.__pwned = 1"><b>bold</b>';

function oldPattern(alt) {
  const info = document.createElement('div');
  info.innerHTML = `<p class="text-sm font-medium">${alt}</p>`;
  return info;
}
function newPattern(alt) {
  // Mirrors the fixed DocumentEditor code exactly.
  const info = document.createElement('div');
  info.className = 'absolute top-4 left-4 bg-black bg-opacity-50 px-4 py-2 rounded text-white';
  const caption = document.createElement('p');
  caption.className = 'text-sm font-medium';
  caption.textContent = alt;
  info.appendChild(caption);
  return info;
}

const oldInfo = oldPattern(MALICIOUS_ALT);
check('control: OLD pattern injects an <img onerror> element from alt', oldInfo.querySelector('img[onerror]') !== null && oldInfo.querySelector('b') !== null);

const newInfo = newPattern(MALICIOUS_ALT);
check('NEW pattern: exactly one <p> child, no injected elements',
  newInfo.children.length === 1 && newInfo.children[0].tagName === 'P' && newInfo.children[0].children.length === 0,
  newInfo.innerHTML.slice(0, 120));
check('NEW pattern: no img/b/script elements anywhere', newInfo.querySelector('img, b, script') === null);
check('NEW pattern: caption text is the literal alt value', newInfo.children[0].textContent === MALICIOUS_ALT);
check('NEW pattern: serialized HTML has the markup escaped', /&lt;img src=x onerror=/.test(newInfo.innerHTML));

// A few more hostile shapes
for (const alt of ['"><script>1</script>', '<svg onload=1>', '</p><iframe src=javascript:1>', '&lt;fake&gt;']) {
  const el = newPattern(alt);
  check(`NEW pattern hostile alt ${JSON.stringify(alt)}: text only`,
    el.children.length === 1 && el.children[0].children.length === 0 && el.children[0].textContent === alt);
}

// Legitimate alt text renders as before
const legit = newPattern('Architecture diagram v2 (2024)');
check('legit alt: rendered text unchanged', legit.textContent === 'Architecture diagram v2 (2024)');
check('legit alt: classes preserved on wrapper and caption',
  legit.className === 'absolute top-4 left-4 bg-black bg-opacity-50 px-4 py-2 rounded text-white'
  && legit.children[0].className === 'text-sm font-medium');
check('legit alt: identical output to old pattern for safe text',
  legit.children[0].outerHTML === oldPattern('Architecture diagram v2 (2024)').children[0].outerHTML);

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
