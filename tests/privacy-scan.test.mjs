/**
 * Guards scripts/privacy-scan.sh - the check that runs before a source
 * tarball is shared (scripts/release.cjs runs it before tagging).
 *
 * What this test proves:
 *   1. the repository's tracked files pass the generic checks (so a leak
 *      committed later fails the suite);
 *   2. a throwaway directory with SYNTHETIC leaks of every kind is caught,
 *      each by its check, and the output masks what it found (the full
 *      synthetic secret and case number never appear);
 *   3. the personal denylist works (a term in a file and in a file name)
 *      and a clean directory passes.
 *
 * Nothing in this file is real: the synthetic leaks are assembled from
 * fragments at run time so that this file itself passes the scan.
 *
 * SKIPs (exit 0, "SKIP:" line) when bash, python3, tar or git is missing.
 *
 * Run:  node tests/privacy-scan.test.mjs
 * Exit code 0 = all checks passed (or skipped), 1 = failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'privacy-scan.sh');

function have(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}
for (const tool of ['bash', 'python3', 'tar', 'git']) {
  if (!have(tool)) { console.log(`SKIP: ${tool} is not installed`); process.exit(0); }
}

let failed = 0;
function check(name, pass, detail = '') {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}
function scan(args) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 1. the repository itself (generic checks; the owner's denylist stays local)
{
  const r = scan(['--tracked', '--no-denylist']);
  check('the tracked files pass the generic checks', r.status === 0, r.out.split('\n').filter(Boolean).slice(-8).join(' | '));
  check('the summary names the mode and counts', /privacy-scan: OK - tracked: \d+ files, \d+ images, 0 finding/.test(r.out));
}

// 2. synthetic leaks, one per check (fragments keep this file clean)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-scan-test-'));
const J = (...parts) => parts.join('');
const awsKey = J('AKIA', 'ABCDEFGHIJKLMNOP');
const caseNumber = J('04', '123456');
const email = J('someone', '@', 'corp-mail', '.', 'not-an-example', '.com');
const userAtIp = J('deployer', '@', '192.168', '.7.9');
const homePath = J('/Users', '/', 'someperson', '/Documents');
const tenant = J('https://', 'acme-corp', '.atlassian', '.net/browse/X-1');
fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'docs', 'notes.txt'), [
  `contact ${email}`, `deploy to ${userAtIp}`, `backup in ${homePath}`,
  `case ${caseNumber} escalated`, `tracker ${tenant}`, `key ${awsKey}`,
  `ok: pi@192.168.0.50, you@example.com, /home/user/reports, 00000000, https://your-company.atlassian.net`,
].join('\n') + '\n');
fs.writeFileSync(path.join(tmp, 'secrets', '.env'), 'X=1\n');
fs.writeFileSync(path.join(tmp, 'big.bin'), Buffer.alloc(1024 * 1024 + 1));
fs.writeFileSync(path.join(tmp, 'docs', 'zyxqoplent-plan.md'), 'The Zyxqoplent account.\n');
const denylist = path.join(tmp, 'denylist.txt');
fs.writeFileSync(denylist, '# synthetic\nzyxqoplent\nre:quux-[0-9]+\n');
fs.writeFileSync(path.join(tmp, 'docs', 'r.txt'), 'see quux-42\n');

// a 1x1 PNG with a tEXt chunk, outside the allowed image folders
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0made on a desk', 'latin1')), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(tmp, 'docs', 'shot.png'), png);
// WebP: a clean one in docs/screenshots/ is allowed, one with an EXIF chunk is reported
function riff(chunks) {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks.map(([t, d]) => { const h = Buffer.alloc(8); h.write(t, 0, 'latin1'); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, d, d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); })]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
fs.mkdirSync(path.join(tmp, 'docs', 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'docs', 'screenshots', 'clean.webp'), riff([['VP8 ', Buffer.alloc(10)]]));
fs.writeFileSync(path.join(tmp, 'docs', 'screenshots', 'tagged.webp'), riff([['VP8 ', Buffer.alloc(10)], ['EXIF', Buffer.from('Exif\0\0camera')]]));
fs.writeFileSync(path.join(tmp, 'docs', 'screenshots', 'shot.png'), png);
fs.writeFileSync(path.join(tmp, 'docs', 'screenshots', 'renamed.webp'), png);   // a PNG (with a tEXt chunk) named .webp
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'public', 'clean.png'), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
]));
fs.writeFileSync(path.join(tmp, 'docs', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><!-- made with ' + J('inks', 'cape') + ' --></svg>\n');

{
  const r = scan(['--dir', tmp, '--denylist', denylist, '--max-mb', '1']);
  check('a directory with synthetic leaks fails', r.status === 1, String(r.status));
  for (const name of ['email', 'user@private-ip', 'home path', 'case number', 'atlassian tenant', 'secret (aws access key)',
    'forbidden file', 'size', 'denylist', 'denylist (file name)', 'image location', 'png metadata', 'svg metadata', 'webp metadata']) {
    const line = r.out.split('\n').find((l) => l.startsWith(name + ' '));
    check(`finds: ${name}`, !!line, line || '-');
  }
  check('the clean png in public/ is not reported', !/clean\.png/.test(r.out));
  check('a PNG renamed .webp in docs/screenshots/ is reported, and its PNG metadata too', /^image location\s+docs\/screenshots\/renamed\.webp\s+named \.webp but not a WebP file/m.test(r.out) && /^png metadata\s+docs\/screenshots\/renamed\.webp/m.test(r.out), r.out.split('\n').filter((l) => /renamed/.test(l)).join(' | '));
  check('a clean WebP in docs/screenshots/ is not reported; a PNG there is (WebP only)', !/clean\.webp/.test(r.out) && /^image location\s+docs\/screenshots\/shot\.png/m.test(r.out), r.out.split('\n').filter((l) => /screenshots/.test(l)).join(' | '));
  check('documented placeholders are not reported (pi@, example.com, /home/user, 00000000, your-company)', !/notes\.txt:7/.test(r.out), r.out.split('\n').filter((l) => l.includes('notes.txt:7')).join(' | '));
  check('the output masks the secret', !r.out.includes(awsKey) && r.out.includes(awsKey.slice(0, 4) + '…'));
  check('the output masks the case number', !r.out.includes(caseNumber));
  check('the output masks the email', !r.out.includes(email));
  check('the denylist regex form works', /denylist\s+docs\/r\.txt:1\s+re:quux/.test(r.out));
  check('the summary counts the findings', /privacy-scan: FAIL - dir: \d+ files, 7 images, \d+ finding/.test(r.out));
}

// 3. a clean directory passes, with and without a denylist
{
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-scan-clean-'));
  fs.writeFileSync(path.join(clean, 'README.md'), '# Hello\n\nContact support@example.com or pi@192.168.0.50.\n');
  const r = scan(['--dir', clean, '--denylist', denylist]);
  check('a clean directory passes with a denylist', r.status === 0 && /privacy-scan: OK/.test(r.out), r.out.trim().split('\n').pop());
  const r2 = scan(['--dir', clean, '--no-denylist']);
  check('a clean directory passes without a denylist', r2.status === 0 && /denylist: none/.test(r2.out));
  fs.rmSync(clean, { recursive: true, force: true });
}

// 4. --ref mode scans what git archive publishes (HEAD here)
{
  const r = scan(['--ref', 'HEAD', '--no-denylist']);
  check('--ref HEAD scans the archive of the commit', /privacy-scan: (OK|FAIL) - ref: \d+ files/.test(r.out), r.out.trim().split('\n').pop());
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
