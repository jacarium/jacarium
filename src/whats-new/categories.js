/**
 * The What's New categories, in the fixed order the window and CHANGELOG.md
 * show them (MISC last). scripts/whats-new-from-git.cjs assigns them to
 * commits and carries the same list; tests/whats-new-from-git.test.mjs
 * keeps the two equal.
 */
export const CATEGORIES = ['DOCUMENTS', 'TASKS', 'KANBAN', 'WORKFLOWS', 'CALENDAR', 'JIRA', 'AI', 'DIAGNOSTICS', 'TEAM', 'SYNC', 'SECURITY', 'SETTINGS', 'UI', 'DESKTOP', 'DEPLOY', 'TESTS', 'MISC'];

/** A version's features grouped by category in the fixed order: [{ category, features }]. */
export function groupFeaturesByCategory(features) {
  const groups = new Map();
  for (const feature of features || []) {
    const category = CATEGORIES.includes(feature.category) ? feature.category : 'MISC';
    if (!groups.has(category)) groups.set(category, { category, features: [] });
    groups.get(category).features.push(feature);
  }
  return CATEGORIES.filter((c) => groups.has(c)).map((c) => groups.get(c));
}

/** The major version lines present, newest first: ['3', '2', ...]. */
export function majorLinesOf(versions) {
  return [...new Set((versions || []).map((v) => String(v.version).split('.')[0]))].sort((a, b) => Number(b) - Number(a));
}

/** Compare two X.Y.Z strings (-1, 0, 1). */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}
