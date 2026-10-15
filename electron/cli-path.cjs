/**
 * The PATH the backend child gets. A desktop app started from the Finder,
 * the Dock or a launcher inherits the login session's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin on macOS), not the shell's, so the
 * command-line tools the backend drives - Taskwarrior's `task` above all -
 * are not found when they live in Homebrew's or the user's bin directories.
 * `withCliPath` appends the usual locations that are missing; it never
 * removes or reorders what is there.
 */
const path = require('path');

const EXTRA = {
  darwin: ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '~/.local/bin', '/opt/local/bin'],
  linux: ['/usr/local/bin', '~/.local/bin', '/snap/bin', '/var/lib/flatpak/exports/bin', '~/.local/share/flatpak/exports/bin', path.join('/home', 'linuxbrew', '.linuxbrew', 'bin')],
  win32: [],
};

function withCliPath(env = process.env, { platform = process.platform, home = env.HOME || env.USERPROFILE || '' } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  const current = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const have = new Set(current);
  const extra = (EXTRA[platform] || []).map((p) => (p.startsWith('~/') && home ? path.join(home, p.slice(2)) : p)).filter((p) => !p.startsWith('~/') && !have.has(p));
  if (!extra.length) return { ...env };
  return { ...env, PATH: [...current, ...extra].join(sep) };
}

module.exports = { withCliPath, EXTRA };
