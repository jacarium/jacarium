/**
 * Pins the pure text helpers of the interactive SSH terminal
 * (src/components/workflow/ssh/sshTerminalText.js), which were inlined in
 * InteractiveSSHTerminal.jsx before and had no test:
 *   - stripAnsi removes colour / cursor / OSC escapes, control characters
 *     (including backspace, bell, DEL) and carriage returns, and keeps
 *     tabs and newlines;
 *   - extractVariables lists the distinct {{VAR}} placeholders of a saved
 *     command in order; replaceVariables fills them (every occurrence);
 *   - parseCompletionOutput turns the shell's TAB TAB echo into candidates:
 *     the appended-completion form, the listed-options form, prompts and the
 *     words of the input itself are dropped, only words extending the word
 *     being completed count, and a trailing space means "any word";
 *   - applyCompletion replaces the last word of the input (or appends after
 *     a trailing space).
 *
 * Run:  node tests/workflow-ssh-terminal-text.test.mjs
 * Preconditions: none beyond Node (no deps).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const { stripAnsi, extractVariables, replaceVariables, parseCompletionOutput, applyCompletion } =
  await import(path.join(REPO, 'src', 'components', 'workflow', 'ssh', 'sshTerminalText.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- stripAnsi ----------
check('stripAnsi: colour and cursor escapes are removed, text kept',
  stripAnsi('\x1b[1;32mroot@host\x1b[0m:\x1b[34m~\x1b[0m$ ls\x1b[K') === 'root@host:~$ ls');
check('stripAnsi: OSC title sequences (BEL and ST terminated) are removed',
  stripAnsi('\x1b]0;title\x07before \x1b]2;t\x1b\\after') === 'before after');
check('stripAnsi: control characters, DEL, bell and CR go; tab and newline stay',
  stripAnsi('a\x08b\x07c\x7fd\r\ne\tf\x00') === 'abcd\ne\tf');
check('stripAnsi: empty / falsy input gives an empty string', stripAnsi('') === '' && stripAnsi(null) === '');

// ---------- variables ----------
check('extractVariables: distinct placeholders in order of first appearance',
  eq(extractVariables('cd {{DIR}} && grep {{PATTERN}} {{DIR}}/log'), ['DIR', 'PATTERN']) && eq(extractVariables('ls -la'), []));
check('replaceVariables: every occurrence is filled',
  replaceVariables('cd {{DIR}} && ls {{DIR}}', { DIR: '/var/log' }) === 'cd /var/log && ls /var/log');

// ---------- parseCompletionOutput ----------
check('completion: the "input + completion" echo yields the completed word',
  eq(parseCompletionOutput('cd 001\x07cd 0010-dir/\n', 'cd 001'), ['0010-dir/']));
check('completion: a listed-options echo yields every option extending the word',
  eq(parseCompletionOutput('cd 00\n0010-dir/  0020-dir/  other/\nuser@host:~$ ', 'cd 00'), ['0010-dir/', '0020-dir/']));
check('completion: prompt lines (ending in $/# or holding user@host) and the input\'s own words are dropped',
  eq(parseCompletionOutput('ls\nuser@host:~$ ls\nroot# \nfile.txt  notes.md', 'ls '), ['file.txt', 'notes.md']));
check('completion: with a trailing space every word is a candidate; without, only words extending the last word',
  eq(parseCompletionOutput('alpha  beta', 'cat '), ['alpha', 'beta']) &&
  eq(parseCompletionOutput('alpha  beta', 'cat a'), ['alpha']));
check('completion: a partial echo of the word being completed and "…/cd"-style concatenations are dropped',
  eq(parseCompletionOutput('cat a\n/tmp/cd', 'cat a'), []));
check('completion: ANSI noise in the echo is ignored and duplicates collapse',
  eq(parseCompletionOutput('\x1b[Kdir1/  \x1b[1mdir1/\x1b[0m  dir2/', 'cd d'), ['dir1/', 'dir2/']));
check('completion: nothing usable gives an empty list', eq(parseCompletionOutput('\n\n', 'cd x'), []));

// ---------- applyCompletion ----------
check('applyCompletion: replaces the last word', applyCompletion('cd 001', '0010-dir/') === 'cd 0010-dir/');
check('applyCompletion: appends after a trailing space', applyCompletion('cd ', 'logs/') === 'cd logs/');
check('applyCompletion: a picked candidate replaces a word it does not extend', applyCompletion('cat x', 'file.txt') === 'cat file.txt');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
