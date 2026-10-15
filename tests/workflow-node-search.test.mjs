/**
 * Guards the node search shared by the Workflow Builder's node library
 * filter, the connection menu and the quick-add palette
 * (src/components/workflow/nodeSearch.js).
 *
 * What this test proves:
 *   - ranking: an exact label beats a label prefix, which beats a word
 *     prefix, which beats a label substring, then the description, then
 *     the type id; ties keep category order; non-matches are dropped; the
 *     query is case-insensitive and trimmed; an empty query lists
 *     everything in category order - so "Enter adds the top match" is the
 *     node the user most likely meant;
 *   - filterCategories keeps the grouping and drops empty categories;
 *   - compatibleCategoriesFor reproduces the connection menu's rules for
 *     the four wire directions and shows everything otherwise.
 *
 * Run:  node tests/workflow-node-search.test.mjs
 * Preconditions: none beyond Node (no deps).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const { rankNodes, filterCategories, compatibleCategoriesFor, nodeMatchRank } =
  await import(path.join(REPO, 'src', 'components', 'workflow', 'nodeSearch.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const n = (type, label, description) => ({ type, label, description });

// A reduced copy of NODE_CATEGORIES (icons omitted: the search never looks at them)
const CATEGORIES = [
  { category: 'Variables', nodes: [n('string', 'String', 'Text value'), n('integer', 'Integer', 'Numeric value'), n('text', 'Text', 'Multi-line text'), n('boolean', 'Boolean', 'True/false value')] },
  { category: 'Control Flow', nodes: [n('beginplay', 'Begin Play', 'Entry point'), n('branch', 'Branch', 'True/false condition'), n('sequence', 'Sequence', 'Execute in order'), n('forloop', 'For Loop', 'Iterate over array')] },
  { category: 'Actions', nodes: [n('restapi', 'REST API', 'HTTP request'), n('transformation', 'Transform', 'JavaScript processor'), n('storage', 'Set Variable', 'Store value in a variable'), n('visualizer', 'Visualizer', 'Inspect data'), n('result', 'Result', 'Workflow result')] },
  { category: 'Notes', nodes: [n('note', 'Note', 'Freeform sticky note'), n('idea', 'Idea', 'Mind-map topic bubble')] },
];
const types = (list) => list.map((x) => x.type);

// ---------- ranking ----------
check('exact label first, then label prefix, word prefix, substring, description, type id',
  nodeMatchRank(n('text', 'Text', ''), 'text') === 0 && nodeMatchRank(n('t', 'Text value', ''), 'text') === 1 &&
  nodeMatchRank(n('t', 'Multi-line Text', ''), 'text') === 2 && nodeMatchRank(n('t', 'Context', ''), 'text') === 3 &&
  nodeMatchRank(n('t', 'String', 'Text value'), 'text') === 4 && nodeMatchRank(n('textual', 'String', ''), 'text') === 5 &&
  nodeMatchRank(n('x', 'Branch', 'Condition'), 'text') === null);
check('"text" ranks the Text node above String (description) and Multi-line matches',
  eq(types(rankNodes(CATEGORIES, 'text')), ['text', 'string']));
check('"var" finds Set Variable by its label word and the Variables nodes by nothing else',
  eq(types(rankNodes(CATEGORIES, 'var')), ['storage']));
check('"loop" matches the For Loop label word; "re" lists label prefixes before description matches (Store, Freeform), ties in category order',
  eq(types(rankNodes(CATEGORIES, 'loop')), ['forloop']) && eq(types(rankNodes(CATEGORIES, 're')), ['restapi', 'result', 'storage', 'note']));
check('the query is case-insensitive and trimmed; non-matches are dropped',
  eq(types(rankNodes(CATEGORIES, '  BRANCH ')), ['branch']) && rankNodes(CATEGORIES, 'zzz').length === 0);
check('an empty query lists every node in category order with its category name',
  rankNodes(CATEGORIES, '').length === 15 && rankNodes(CATEGORIES, '')[0].type === 'string' && rankNodes(CATEGORIES, '')[0].category === 'Variables' &&
  rankNodes(CATEGORIES, '  ').at(-1).type === 'idea');
check('ranking never mutates the input', CATEGORIES[0].nodes.length === 4 && !('category' in CATEGORIES[0].nodes[0]));

// ---------- grouped filtering ----------
const grouped = filterCategories(CATEGORIES, 'res');
check('filterCategories keeps the grouping and drops empty categories',
  eq(grouped.map((c) => c.category), ['Actions']) && eq(types(grouped[0].nodes), ['restapi', 'result']));
check('filterCategories with an empty query returns everything', filterCategories(CATEGORIES, '').length === 4);

// ---------- wire-direction compatibility (the connection menu) ----------
const names = (list) => list.map((c) => c.category);
const execSource = compatibleCategoriesFor(CATEGORIES, 'execution-source');
check('execution-source: no Variables or Notes, no Begin Play, everything else with an exec input',
  eq(names(execSource), ['Control Flow', 'Actions']) && !types(execSource[0].nodes).includes('beginplay') && types(execSource[1].nodes).includes('result'));
const execTarget = compatibleCategoriesFor(CATEGORIES, 'execution-target');
check('execution-target: Begin Play, Control Flow and Actions (nodes with an exec output), no Notes',
  eq(names(execTarget), ['Control Flow', 'Actions']) && types(execTarget[0].nodes).includes('beginplay'));
const dataSource = compatibleCategoriesFor(CATEGORIES, 'data-source');
check('data-source: every node except Begin Play',
  eq(names(dataSource), ['Variables', 'Control Flow', 'Actions', 'Notes']) && !types(dataSource[1].nodes).includes('beginplay') && types(dataSource[1].nodes).includes('branch'));
const dataTarget = compatibleCategoriesFor(CATEGORIES, 'data-target');
check('data-target: Variables, Notes and the data-producing actions (REST API, Transform, Visualizer)',
  eq(names(dataTarget), ['Variables', 'Actions', 'Notes']) && eq(types(dataTarget[1].nodes), ['restapi', 'transformation', 'visualizer']));
check('an unknown connection type shows everything', compatibleCategoriesFor(CATEGORIES, undefined) === CATEGORIES);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
