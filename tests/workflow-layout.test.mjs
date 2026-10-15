/**
 * Guards the canvas layout helpers behind the Workflow Builder's Align,
 * Distribute and Auto-tidy actions (src/components/workflow/workflowLayout.js)
 * and the wiring rules behind the valid/invalid pin feedback
 * (src/components/workflow/workflowConnections.js).
 *
 * What this test proves:
 *   - alignNodes lines a selection up on its joint bounding box (left /
 *     centre / right / top / middle / bottom), ignores a single node and
 *     unknown modes, and never moves unselected nodes or mutates its input;
 *   - distributeNodes keeps the outer two nodes and equalises the gaps,
 *     and needs at least three nodes;
 *   - tidyColumns: execution edges give longest-path columns (a node sits
 *     right of everything that runs before it, also across a Sequence
 *     fan-out), pin-less data nodes land one column left of their earliest
 *     consumer (a variable feeding a data node feeding a flow node goes two
 *     left), unattached nodes get a column at the far right, notes are
 *     never placed, a cycle does not hang;
 *   - tidyLayout: rows within a column follow the feeders' rows, nothing in
 *     a column overlaps, the diagram keeps its original top-left, notes keep
 *     their positions, the input is untouched;
 *   - pinKind tells execution pins (exec-in/out, true/false, case-N,
 *     default, loop-body, completed, Sequence's output-N) from data pins
 *     (Begin Play's output-<name>, data-in/out, left/right-in, link pins);
 *   - describeConnectionProblem rejects self-wiring, exec<->data mixes and
 *     execution wires into pin-less nodes, with a reason, and allows the
 *     rest.
 *
 * Run:  node tests/workflow-layout.test.mjs
 * Preconditions: none beyond Node (no deps).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const { alignNodes, distributeNodes, tidyColumns, tidyLayout, TIDY_GAP } =
  await import(path.join(REPO, 'src', 'components', 'workflow', 'workflowLayout.js'));
const { pinKind, describeConnectionProblem, isConnectionAllowed } =
  await import(path.join(REPO, 'src', 'components', 'workflow', 'workflowConnections.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined ? ' | ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const node = (id, type, x, y, width = 100, height = 50) => ({ id, type, position: { x, y }, width, height, data: {} });
const exec = (source, target, sourceHandle = 'exec-out') => ({ id: `x-${source}-${target}`, source, target, sourceHandle, targetHandle: 'exec-in', type: 'execution' });
const data = (source, target) => ({ id: `d-${source}-${target}`, source, target, sourceHandle: 'data-out', targetHandle: 'data-in', type: 'data' });
const pos = (nodes, id) => nodes.find((n) => n.id === id).position;

// ---------- align ----------
{
  const nodes = [node('a', 'string', 10, 10, 100, 50), node('b', 'string', 200, 100, 60, 30), node('c', 'string', 50, 300, 80, 80), node('z', 'string', 999, 999)];
  const ids = ['a', 'b', 'c'];
  check('align left / right use the selection\'s bounding box',
    eq(ids.map((id) => pos(alignNodes(nodes, ids, 'left'), id).x), [10, 10, 10]) && eq(ids.map((id) => pos(alignNodes(nodes, ids, 'right'), id).x), [160, 200, 180]));
  check('align center lines the horizontal centres up on the box\'s centre (135)',
    eq(ids.map((id) => pos(alignNodes(nodes, ids, 'center'), id).x), [85, 105, 95]));
  check('align top / middle / bottom likewise on the vertical axis',
    eq(ids.map((id) => pos(alignNodes(nodes, ids, 'top'), id).y), [10, 10, 10]) && eq(ids.map((id) => pos(alignNodes(nodes, ids, 'bottom'), id).y), [330, 350, 300]) &&
    eq(ids.map((id) => pos(alignNodes(nodes, ids, 'middle'), id).y), [170, 180, 155]));
  check('unselected nodes keep their place; a lone node or an unknown mode changes nothing; the input is not mutated',
    pos(alignNodes(nodes, ids, 'left'), 'z').x === 999 && alignNodes(nodes, ['a'], 'left') === nodes && alignNodes(nodes, ids, 'diagonal') === nodes && pos(nodes, 'b').x === 200);
}

// ---------- distribute ----------
{
  const nodes = [node('a', 'string', 0, 0, 100, 50), node('b', 'string', 120, 0, 100, 50), node('c', 'string', 400, 0, 100, 50), node('d', 'string', 1000, 0, 100, 50)];
  const out = distributeNodes(nodes, ['a', 'b', 'c'], 'horizontal');
  check('distribute horizontally keeps the outer nodes and spaces the gaps evenly',
    pos(out, 'a').x === 0 && pos(out, 'c').x === 400 && pos(out, 'b').x === 200 && pos(out, 'd').x === 1000);
  const tall = [node('a', 'string', 0, 0, 100, 100), node('b', 'string', 0, 500, 100, 50), node('c', 'string', 0, 150, 100, 100)];
  const v = distributeNodes(tall, ['a', 'b', 'c'], 'vertical');
  check('distribute vertically sorts by y and equalises the gaps (a 0..100, c 250..350, b 500..550 -> gaps 150/150)',
    pos(v, 'a').y === 0 && pos(v, 'c').y === 250 && pos(v, 'b').y === 500);
  check('fewer than three nodes, or an unknown axis, changes nothing', distributeNodes(nodes, ['a', 'b'], 'horizontal') === nodes && distributeNodes(nodes, ['a', 'b', 'c'], 'diagonal') === nodes);
}

// ---------- tidy columns ----------
{
  const nodes = [
    node('bp', 'beginplay', 0, 0), node('api', 'restapi', 0, 0), node('seq', 'sequence', 0, 0), node('v1', 'visualizer', 0, 0), node('v2', 'visualizer', 0, 0),
    node('res', 'result', 0, 0), node('s', 'string', 0, 0), node('cmp', 'comparison', 0, 0), node('i', 'integer', 0, 0), node('lonely', 'delay', 0, 0), node('note', 'note', 5, 5),
  ];
  const edges = [
    exec('bp', 'api'), exec('api', 'seq'), exec('seq', 'v1', 'output-0'), exec('seq', 'v2', 'output-1'), exec('v1', 'res'), exec('v2', 'res'),
    data('s', 'cmp'), data('i', 'cmp'), data('cmp', 'v2'), data('api', 'res'),
  ];
  const col = tidyColumns(nodes, edges);
  check('execution edges give longest-path columns, also across a Sequence fan-out and a join',
    col.bp === 0 && col.api === 1 && col.seq === 2 && col.v1 === 3 && col.v2 === 3 && col.res === 4, JSON.stringify(col));
  check('data-only nodes sit one column left of their earliest consumer, transitively (cmp left of v2, its variables left of cmp)',
    col.cmp === 2 && col.s === 1 && col.i === 1, JSON.stringify(col));
  check('an unattached node gets its own column at the far right; notes are not placed',
    col.lonely === 5 && !('note' in col), JSON.stringify(col));

  const shifted = tidyColumns([node('s', 'string', 0, 0), node('bp', 'beginplay', 0, 0), node('v', 'visualizer', 0, 0)], [exec('bp', 'v'), data('s', 'bp')]);
  check('a variable feeding the start node pushes everything right so the leftmost column is 0', shifted.s === 0 && shifted.bp === 1 && shifted.v === 2);

  const cyc = tidyColumns([node('a', 'delay', 0, 0), node('b', 'delay', 0, 0), node('c', 'delay', 0, 0)], [exec('a', 'b'), exec('b', 'c'), exec('c', 'a')]);
  check('a cycle of execution edges does not hang and every node gets a column', Object.keys(cyc).length === 3);
}

// ---------- tidy layout ----------
{
  const nodes = [
    node('bp', 'beginplay', 300, 400, 200, 100), node('seq', 'sequence', 0, 0, 200, 150), node('top', 'visualizer', 50, 900, 300, 100), node('bottom', 'visualizer', 60, 100, 300, 100),
    node('res', 'result', 0, 0, 200, 100), node('note', 'note', 42, 43, 180, 110),
  ];
  const edges = [exec('bp', 'seq'), exec('seq', 'bottom', 'output-0'), exec('seq', 'top', 'output-1'), exec('bottom', 'res'), exec('top', 'res')];
  const out = tidyLayout(nodes, edges);
  const p = (id) => pos(out, id);
  check('columns run left to right from the diagram\'s original top-left, each column as wide as its widest node plus the gap',
    eq(p('bp'), { x: 0, y: 0 }) && eq(p('seq'), { x: 200 + TIDY_GAP.x, y: 0 }) && p('top').x === 200 + TIDY_GAP.x + 200 + TIDY_GAP.x && p('res').x === p('top').x + 300 + TIDY_GAP.x,
    JSON.stringify(out.map((n) => [n.id, n.position])));
  check('rows in a column are stacked without overlap, in current-y order for siblings of the same feeder',
    p('bottom').y === 0 && p('top').y === 100 + TIDY_GAP.y);
  check('notes keep their position and the input is untouched',
    eq(p('note'), { x: 42, y: 43 }) && eq(nodes.find((n) => n.id === 'bp').position, { x: 300, y: 400 }));

  // feeders decide the row: a node fed by the lower sibling lands below one fed by the upper
  const fan = [node('bp', 'beginplay', 0, 0), node('seq', 'sequence', 0, 0), node('a', 'delay', 0, 10), node('b', 'delay', 0, 20), node('fb', 'visualizer', 0, 0), node('fa', 'visualizer', 0, 5)];
  const fanEdges = [exec('bp', 'seq'), exec('seq', 'a', 'output-0'), exec('seq', 'b', 'output-1'), exec('b', 'fb'), exec('a', 'fa')];
  const fanOut = tidyLayout(fan, fanEdges);
  check('a node fed from a lower row is placed below a node fed from an upper row (wires stay straight)',
    pos(fanOut, 'fa').y < pos(fanOut, 'fb').y);
  check('a workflow of only notes is returned as is', tidyLayout([node('n', 'note', 1, 2)], []).length === 1);
}

// ---------- wiring rules ----------
{
  check('pinKind: execution pins', ['exec-in', 'exec-out', 'true', 'false', 'default', 'loop-body', 'completed', 'case-3'].every((id) => pinKind('branch', id) === 'exec') && pinKind('sequence', 'output-2') === 'exec');
  check('pinKind: data pins (Begin Play output-<name>, data-in/out, left/right-in, note links)',
    ['output-host', 'input-host'].every((id) => pinKind('beginplay', id) === 'data') && ['data-in', 'data-out', 'left-in', 'right-in', 'link-top', 'link-bottom'].every((id) => pinKind('x', id) === 'data'));
  const byId = { bp: node('bp', 'beginplay', 0, 0), s: node('s', 'string', 0, 0), v: node('v', 'visualizer', 0, 0), br: node('br', 'branch', 0, 0) };
  const problem = (c) => describeConnectionProblem(c, byId, [{ category: 'Variables', nodes: [{ type: 'string', label: 'String' }] }]);
  check('an execution wire into a data pin, and the reverse, are refused with a reason naming the pin kinds',
    /execution pin/.test(problem({ source: 'bp', sourceHandle: 'exec-out', target: 'v', targetHandle: 'data-in' })) &&
    /data pin/.test(problem({ source: 's', sourceHandle: 'data-out', target: 'v', targetHandle: 'exec-in' })));
  check('an execution wire into a pin-less node (String) names the node type', problem({ source: 'bp', sourceHandle: 'exec-out', target: 's', targetHandle: 'exec-in' }) === 'A String node has no execution input.');
  check('a node cannot be wired to itself; a missing node is reported',
    /itself/.test(problem({ source: 'v', sourceHandle: 'data-out', target: 'v', targetHandle: 'data-in' })) && /no longer exists/.test(problem({ source: 'v', sourceHandle: 'data-out', target: 'nope', targetHandle: 'data-in' })));
  check('exec->exec and data->data wires are allowed (Branch TRUE pin included)',
    isConnectionAllowed({ source: 'bp', sourceHandle: 'exec-out', target: 'v', targetHandle: 'exec-in' }, byId) &&
    isConnectionAllowed({ source: 'br', sourceHandle: 'true', target: 'v', targetHandle: 'exec-in' }, byId) &&
    isConnectionAllowed({ source: 's', sourceHandle: 'data-out', target: 'br', targetHandle: 'data-in' }, byId));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
