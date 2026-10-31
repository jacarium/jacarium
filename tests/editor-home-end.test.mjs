/**
 * Home / End in the Documents editor (src/utils/lineCaret.js and its wiring in
 * DocumentEditor.jsx): the start / end of the current logical line, a smart
 * Home (first non-blank character, then column 0), Shift extending from the
 * anchor - not the whole document; Cmd/Ctrl+Home/End are left to the browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineAt, homeEndSelection } from '../src/utils/lineCaret.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ` | ${JSON.stringify(info)}`}`); };
const at = (pos) => ({ start: pos, end: pos, direction: 'none' });

const text = 'first line\n  - indented item\n\nlast';
//            0         10 11              27 28 29
const i = (s) => text.indexOf(s);

check('lineAt: a middle line', JSON.stringify(lineAt(text, i('indented'))) === JSON.stringify([11, 28]), lineAt(text, i('indented')));
check('lineAt: the first and the last line', JSON.stringify(lineAt(text, 3)) === JSON.stringify([0, 10]) && JSON.stringify(lineAt(text, text.length)) === JSON.stringify([30, 34]), [lineAt(text, 3), lineAt(text, text.length)]);
check('lineAt: an empty line', JSON.stringify(lineAt(text, 29)) === JSON.stringify([29, 29]), lineAt(text, 29));

check('End on a middle line goes to that line\'s end, not the document end', homeEndSelection(text, 'End', false, at(i('item'))).start === 28);
check('End on the first line stops at its newline', homeEndSelection(text, 'End', false, at(2)).start === 10);
check('End on the last line goes to the text end', homeEndSelection(text, 'End', false, at(31)).start === text.length);
check('Home on an indented line goes to its first non-blank character', homeEndSelection(text, 'Home', false, at(i('item'))).start === i('- indented'));
check('Home again (already there) goes to column 0', homeEndSelection(text, 'Home', false, at(i('- indented'))).start === 11);
check('Home on an unindented line goes to column 0', homeEndSelection(text, 'Home', false, at(5)).start === 0);
check('Home on an empty line stays at column 0', homeEndSelection(text, 'Home', false, at(29)).start === 29);
check('Home / End without Shift collapse the selection', (() => { const r = homeEndSelection(text, 'End', false, { start: 2, end: 5, direction: 'forward' }); return r.start === r.end && r.start === 10; })());

const sEnd = homeEndSelection(text, 'End', true, at(3));
check('Shift+End selects from the caret to the line end', sEnd.start === 3 && sEnd.end === 10 && sEnd.direction === 'forward', sEnd);
const sHome = homeEndSelection(text, 'Home', true, at(7));
check('Shift+Home selects back to the line start, backward', sHome.start === 0 && sHome.end === 7 && sHome.direction === 'backward', sHome);
const ext = homeEndSelection(text, 'End', true, { start: 2, end: 5, direction: 'backward' });
check('Shift+End from a backward selection keeps its anchor (the end) and moves the focus', ext.start === 5 && ext.end === 10 && ext.direction === 'forward', ext);

const editor = fs.readFileSync(path.join(REPO, 'src/components/features/documents/DocumentEditor.jsx'), 'utf8');
check('the editor handles Home/End without Cmd/Ctrl/Alt, outside the slash menu, through homeEndSelection, and prevents the default',
  /\(e\.key === 'Home' \|\| e\.key === 'End'\) && !hasChordModifier\(e\) && !e\.altKey && !slashMenu\.visible/.test(editor)
  && /homeEndSelection\(textarea\.value, e\.key, e\.shiftKey/.test(editor) && /setSelectionRange\(next\.start, next\.end, next\.direction\)/.test(editor));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
