/**
 * The backend child's PATH (electron/cli-path.cjs): a desktop app started
 * from the Finder/Dock inherits the login session's minimal PATH, so the
 * backend could not find Homebrew's `task`. withCliPath appends the usual
 * tool directories that are missing and leaves the rest alone; main.cjs
 * spawns the backend with it.
 *
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const { withCliPath } = req(path.join(REPO, 'electron', 'cli-path.cjs'));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const finder = withCliPath({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/opt/example-home' }, { platform: 'darwin' });
check('macOS: the Finder PATH gains Homebrew (arm64 and Intel) and ~/.local/bin, in order after the existing entries', finder.PATH === '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/opt/example-home/.local/bin:/opt/local/bin', finder.PATH);
const shell = withCliPath({ PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/opt/example-home' }, { platform: 'darwin' });
check('macOS: a shell PATH that already has them keeps its order and only gains the missing ones', shell.PATH.startsWith('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:') && !/\/opt\/homebrew\/bin.*\/opt\/homebrew\/bin/.test(shell.PATH), shell.PATH);
const linux = withCliPath({ PATH: '/usr/bin:/bin', HOME: '/opt/example-home-linux' }, { platform: 'linux' });
check('Linux: /usr/local/bin, ~/.local/bin, snap and flatpak exports are appended', /:\/usr\/local\/bin:\/opt\/example-home-linux\/\.local\/bin:\/snap\/bin:/.test(linux.PATH) && /flatpak/.test(linux.PATH), linux.PATH);
const win = withCliPath({ Path: 'C:\\Windows\\system32', PATH: 'C:\\Windows\\system32' }, { platform: 'win32' });
check('Windows: nothing is added', win.PATH === 'C:\\Windows\\system32');
const other = withCliPath({ PATH: '/usr/bin', HOME: '/opt/example-home', FOO: 'bar' }, { platform: 'darwin' });
check('every other variable passes through untouched', other.FOO === 'bar' && Object.keys(other).includes('HOME'));
const noHome = withCliPath({ PATH: '/usr/bin' }, { platform: 'darwin', home: '' });
check('without a home the ~/ entries are left out (no literal ~)', !/~/.test(noHome.PATH) && /\/opt\/homebrew\/bin/.test(noHome.PATH), noHome.PATH);
const main = fs.readFileSync(path.join(REPO, 'electron', 'main.cjs'), 'utf8');
check('main.cjs spawns the backend with withCliPath(process.env)', /require\('\.\/cli-path\.cjs'\)/.test(main) && /\.\.\.withCliPath\(process\.env\),\s*PORT: port/.test(main));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
