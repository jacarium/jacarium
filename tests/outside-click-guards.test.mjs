/**
 * Every capture-phase outside-click listener in src/ checks containment.
 *
 * A listener registered on the document (or the window) for click /
 * mousedown / pointerdown in the capture phase runs BEFORE the element's
 * own handler. One that closes a menu on any such event closes it on a
 * click on the menu's own item too; production React then unmounts the
 * item before it delivers the click, and nothing happens (the Media
 * Library's ... menu, Replace Image and all, in the packaged app - the dev
 * server's timing hid it). So each such handler must look at the event's
 * target: a `.contains(` test against the menu's node (or a ref to it)
 * somewhere in its body, or an explicit exception on the line right above
 * the registration:
 *
 *   // outside-click: no containment - <why this listener may run on inside clicks>
 *
 * The handler may be an inline function or a named one declared in the
 * same file (const / let / var / function); a handler this test cannot
 * find is a failure too, so the check never passes by accident.
 *
 * Run:  node tests/outside-click-guards.test.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'src');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs|tsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

// document.addEventListener('click', handler, true | { capture: true, ... })
const REGISTRATION = /(?:document|window)\.addEventListener\(\s*['"](click|mousedown|pointerdown)['"]\s*,\s*/g;
const EXCEPTION = /\/\/\s*outside-click:\s*no containment\s*-\s*\S/;

/** The end (exclusive) of the balanced (...) / {...} run starting at `i` (s[i] is the opener), or -1. */
function balancedEnd(s, i) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') { if (stack.pop() !== ch) return -1; if (stack.length === 0) return j + 1; }
  }
  return -1;
}

/**
 * The handler argument's text and where the registration's next argument
 * starts, from the position right after "addEventListener('click', ".
 * The handler is an identifier, or an inline function / arrow whose
 * parameter list and body are balanced; anything else is left alone.
 */
function handlerArgument(s, from) {
  let i = from;
  const named = /^[A-Za-z_$][\w$]*(?=\s*[,)])/.exec(s.slice(i));
  if (named) return { text: named[0], next: i + named[0].length };
  const fn = /^(?:async\s+)?function\b[^(]*/.exec(s.slice(i));
  if (fn) {
    i += fn[0].length;
    const params = balancedEnd(s, i); if (params < 0) return null;
    const body = s.indexOf('{', params); const end = balancedEnd(s, body); if (end < 0) return null;
    return { text: s.slice(from, end), next: end };
  }
  const arrowHead = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(s.slice(i));
  if (!arrowHead) return null;
  i += arrowHead[0].length;
  if (s[i] === '{') { const end = balancedEnd(s, i); if (end < 0) return null; return { text: s.slice(from, end), next: end }; }
  // an expression body: up to the comma or bracket that ends the argument
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if ('({['.includes(s[j])) depth += 1;
    else if (')}]'.includes(s[j])) { if (depth === 0) return { text: s.slice(from, j), next: j }; depth -= 1; }
    else if (s[j] === ',' && depth === 0) return { text: s.slice(from, j), next: j };
  }
  return null;
}

/** The body of a function expression / arrow starting at `start` in `s` (the text between its braces), or null. */
function bodyAfter(s, start) {
  const open = s.indexOf('{', start);
  if (open < 0) return null;
  const end = balancedEnd(s, open);
  return end < 0 ? null : s.slice(open + 1, end - 1);
}

/** The handler's source: inline (the registration's own argument) or the named function declared in the file. */
function handlerBody(s, handlerText) {
  const inline = handlerText.trim();
  if (/^(?:async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.test(inline) || /^(?:async\s+)?function\b/.test(inline)) {
    return bodyAfter(inline, 0) ?? inline.replace(/^(?:async\s*)?(\([^)]*\)|[\w$]+)\s*=>\s*/, '');
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(inline)) return null;
  const decl = new RegExp(`(?:const|let|var)\\s+${inline}\\s*=\\s*(?:useCallback\\(\\s*)?(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*=>|function\\s+${inline}\\s*\\([^)]*\\)`);
  const m = decl.exec(s);
  if (!m) return null;
  return bodyAfter(s, m.index + m[0].length - 1);
}

const files = walk(SRC);
let registrations = 0;
for (const file of files) {
  const s = readFileSync(file, 'utf8');
  REGISTRATION.lastIndex = 0;
  let m;
  while ((m = REGISTRATION.exec(s))) {
    const arg = handlerArgument(s, m.index + m[0].length);
    if (!arg) continue;
    // the third argument: `true` or an options object with capture: true; otherwise a bubble-phase listener, not this test's
    const rest = /^\s*,\s*(true|\{[^}]*\bcapture\s*:\s*true[^}]*\})\s*\)/.exec(s.slice(arg.next));
    if (!rest) continue;
    registrations += 1;
    const rel = path.relative(REPO, file);
    const line = s.slice(0, m.index).split('\n').length;
    const lineStart = s.lastIndexOf('\n', m.index - 1);
    const previousLine = s.slice(s.lastIndexOf('\n', lineStart - 1) + 1, lineStart);
    const where = `${rel}:${line} (${m[1]}, capture)`;
    if (EXCEPTION.test(previousLine)) { check(`${where}: an annotated exception`, true, previousLine.trim()); continue; }
    const body = handlerBody(s, arg.text);
    if (body === null) { check(`${where}: the handler could be found`, false, arg.text.slice(0, 80)); continue; }
    check(`${where}: the handler checks containment before acting`, /\.contains\(/.test(body), body.replace(/\s+/g, ' ').slice(0, 160));
  }
}
check('the scan found the capture-phase outside-click listeners it is meant to guard', registrations >= 8, `${registrations} registration(s) in ${files.length} files`);

console.log(failed ? `\n${failed} check(s) failed` : `\nAll checks passed (${registrations} listeners)`);
process.exit(failed ? 1 : 0);
