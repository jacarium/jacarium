/**
 * Where a Taskwarrior instance lives on THIS device.
 *
 * An instance row carries rcPath and dataPath. Rows written by this app use
 * the `~/.task/<name>` form, which every device resolves against its own
 * home (the desktop profile's home, the account's home on a server). Rows
 * that came from an older export or another machine can carry absolute
 * paths (the previous app's profile folder under a user's home,
 * `/data/users/<id>/.task` on a server, ...): those point at folders that do not exist
 * here, must not be created here, and are refused by the server's path
 * confinement. Such rows are rewritten once to the `~/.task/<slug>` form -
 * on import, and by the follower when it meets one - and the rewrite is an
 * ordinary tracked update, so it synchronises once and a device that
 * receives the `~/...` row has nothing left to rewrite (no ping-pong).
 */

/** The directory name for an instance: lower-case, [a-z0-9._-], never empty. */
export function instanceSlug(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'instance';
}

/** The rc file's own name when the path names one (.taskrc, taskrc, work.taskrc ...), else .taskrc. */
export function rcFileName(rcPath) {
  const base = String(rcPath || '').trim().split(/[\\/]/).pop() || '';
  return /taskrc/i.test(base) ? base : '.taskrc';
}

/** The paths this app gives an instance of that name: ~/.task/<slug> and the rc file inside it. */
export function defaultInstancePaths(name, rcPath = null) {
  const slug = instanceSlug(name);
  return { dataPath: `~/.task/${slug}`, rcPath: `~/.task/${slug}/${rcFileName(rcPath)}` };
}

/**
 * True for a path that belongs to another machine: under a user's home
 * directory (macOS, Linux, root), under a server's accounts root, the
 * previous app's profile folders, a Windows drive or a UNC share. Other absolute paths (a shared /srv or /tmp directory a
 * user set up on purpose) are left alone at import; the follower rewrites
 * any absolute path that does not validate on the device it runs on.
 */
export function isForeignTaskPath(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return /^\/(Users|home|root|data\/users)\//.test(text) || /\/\.config\/support-console/.test(text) || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\');
}

/** True for any absolute path (what the follower rewrites when it does not validate here). */
export function isAbsoluteTaskPath(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\');
}

/**
 * The row with foreign paths replaced by this app's `~/.task/<slug>` form.
 * Returns { row, rewritten }: `row` is the input when nothing was foreign.
 * A foreign dataPath takes both paths along (the rc belongs with the data,
 * keeping the rc file's own name); a foreign rcPath alone becomes
 * `<dataPath>/<rc name>` when the data path is `~/...`, else the default.
 */
export function normaliseInstancePaths(row, { foreign = isForeignTaskPath } = {}) {
  if (!row || typeof row !== 'object') return { row, rewritten: false };
  const foreignData = foreign(row.dataPath);
  const foreignRc = foreign(row.rcPath);
  if (!foreignData && !foreignRc) return { row, rewritten: false };
  const defaults = defaultInstancePaths(row.name, row.rcPath);
  if (foreignData) return { row: { ...row, ...defaults }, rewritten: true };
  const dataPath = String(row.dataPath || '').trim();
  const rcPath = dataPath.startsWith('~/') ? `${dataPath.replace(/\/+$/, '')}/${rcFileName(row.rcPath)}` : defaults.rcPath;
  return { row: { ...row, rcPath }, rewritten: true };
}
