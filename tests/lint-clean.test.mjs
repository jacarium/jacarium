#!/usr/bin/env node
/**
 * `npm run lint` is clean and stays clean: the lint script refuses warnings (eslint --max-warnings 0), so the
 * five react-hooks/exhaustive-deps warnings of 3.4.5 cannot creep back silently (OpenSSF Best Practices
 * warnings_fixed; CONTRIBUTING.md asks for a clean lint), and no new exhaustive-deps suppression without a reason
 * (the `-- <reason>` form) joins the 81 that predate that rule - a ratchet that only goes down.
 *
 * Run: node tests/lint-clean.test.mjs   (static; the lint itself runs through `npm run lint`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : ' | ' + String(detail).slice(0, 400)}`); if (!ok) failed++; };

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
check('package.json: the lint script refuses warnings (eslint --max-warnings 0)', /\beslint\b.*--max-warnings 0\b/.test(pkg.scripts.lint), pkg.scripts.lint);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(jsx?|cjs|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const bare = [];
for (const f of [...walk(path.join(REPO, 'src')), ...walk(path.join(REPO, 'electron'))]) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/eslint-disable(-next-line|-line)?\s+react-hooks\/exhaustive-deps/.test(l) && !/--\s*\S/.test(l)) bare.push(`${path.relative(REPO, f)}:${i + 1}`);
  });
}
// a ratchet: 81 suppressions predate the rule that a suppression names its reason; new ones must, and the
// count can only go down (lower the number here when some are given reasons or removed)
const BARE_SUPPRESSIONS_MAX = 81;
check(`no new react-hooks/exhaustive-deps suppression without a reason (-- <reason>): ${bare.length} bare, at most ${BARE_SUPPRESSIONS_MAX}`, bare.length <= BARE_SUPPRESSIONS_MAX, bare.slice(-5).join(', '));

const contributing = fs.readFileSync(path.join(REPO, 'CONTRIBUTING.md'), 'utf8');
check('CONTRIBUTING.md asks for a clean lint', /npm run lint/.test(contributing));

console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
