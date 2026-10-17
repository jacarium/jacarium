/**
 * Workflows are read-only on a phone, and every sidebar row gets a chevron
 * that opens its right-click menu (phones have no right-click):
 *   - WorkflowList with readOnly: no "New workflow" and no selection
 *     button; its hamburger menu keeps the sort order and the exports but
 *     offers no Variables / New / Import; a row cannot be renamed;
 *   - WorkflowContextMenu with readOnly: Add as AI Context and the exports
 *     stay, Duplicate / Share with the Team / Stop Sharing / Delete do not;
 *     the category menu keeps its exports only; the bulk menu is empty;
 *   - MobileWorkflowView: linearize() follows the execution path from
 *     Begin Play, lists a branch's outlets with their targets, puts notes
 *     first and data nodes last; the rendered reader shows the REST method,
 *     the URL, TRUE/FALSE and the "View only" toolbar with Run/Stop;
 *   - RowMenuButton (the chevron): absent outside the phone layout, present
 *     in it with a 44px target; its tap calls the row's context-menu
 *     handler and does not reach the row's click (no open/select), in
 *     ItemList (documents, boards, task lists) and in WorkflowRow, where the
 *     menu it opens respects readOnly.
 * Needs jsdom + fake-indexeddb (npm install --no-save jsdom fake-indexeddb).
 * Run: node tests/mobile-workflow-readonly.test.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'helpers', 'mobile-workflow-entry.mjs');
fs.writeFileSync(entry, `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowList from '@worktree/src/components/workflow/WorkflowList.jsx';
import WorkflowContextMenu from '@worktree/src/components/workflow/WorkflowContextMenu.jsx';
import WorkflowListMenu from '@worktree/src/components/workflow/WorkflowListMenu.jsx';
import WorkflowRow from '@worktree/src/components/workflow/WorkflowRow.jsx';
import ItemList from '@worktree/src/components/common/sidebar/ItemList.jsx';
import RowMenuButton from '@worktree/src/components/mobile/RowMenuButton.jsx';
import MobileWorkflowView, { MobileWorkflowToolbar, linearize, summarize, describe } from '@worktree/src/components/mobile/MobileWorkflowView.jsx';
import { MobileProvider } from '@worktree/src/contexts/MobileContext.jsx';
import { NotificationProvider } from '@worktree/src/contexts/NotificationContext.jsx';
export { React, act, createRoot, WorkflowList, WorkflowContextMenu, WorkflowListMenu, WorkflowRow, ItemList, RowMenuButton, MobileWorkflowView, MobileWorkflowToolbar, linearize, summarize, describe, MobileProvider, NotificationProvider };
`);

const { check, summary } = makeChecker();
const env = await setupDocumentsEnv('mobile-workflow', { entry });
const { mod, window, sleep } = env;
const { React, act, createRoot, WorkflowList, WorkflowContextMenu, WorkflowListMenu, WorkflowRow, ItemList, RowMenuButton, MobileWorkflowView, MobileWorkflowToolbar, linearize, summarize, describe, MobileProvider, NotificationProvider } = mod;
void WorkflowListMenu;
const { document } = window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The phone layout is decided by two media queries: this stub answers them
// as a phone or as a desktop, per test
let phone = false;
window.matchMedia = (q) => ({ matches: phone && (/max-width: 767px/.test(q) || /pointer: coarse/.test(q)), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

async function mount(element, { mobile = false } = {}) {
  phone = mobile;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  // (the list's sharing hook needs the notifications context, as in the app)
  await act(async () => { root.render(React.createElement(NotificationProvider, null, React.createElement(MobileProvider, null, element))); });
  await sleep(10);
  return { host, root, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const texts = (host, sel = 'button') => Array.from(host.querySelectorAll(sel)).map((b) => b.textContent.trim());
const tap = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); }); };

const workflows = [
  { id: 1, title: 'Health check and notify', category: 'Operations', nodes: [], edges: [], updatedAt: 2 },
  { id: 2, title: 'Nightly backup', category: 'Operations', nodes: [], edges: [], updatedAt: 1 },
];
const listProps = (over) => ({
  workflows, onWorkflowClick() {}, onWorkflowDelete() {}, onWorkflowDuplicate() {}, onWorkflowRename() {}, onCategoryRename() {}, onWorkflowCategoryChange() {},
  onNewWorkflow() {}, currentWorkflowId: 1, selectionMode: false, selectedWorkflows: [], onToggleSelectionMode() {}, onToggleWorkflowSelection() {},
  onBulkDelete() {}, onBulkMove() {}, onExportAll() {}, onImport() {}, onExportBase64() {}, onImportBase64() {}, onOpenVariables() {}, onWorkflowsChanged() {},
  sortBy: 'date', onSortChange() {}, centralServerStatus: null, ...over,
});

try {
  // ---- 1. the list, read-only ----
  let m = await mount(React.createElement(WorkflowList, listProps({})));
  check('1. the desktop list offers New workflow and the selection toggle', !!m.host.querySelector('[data-testid="workflow-new"]') && !!m.host.querySelector('[title="Select multiple"]'));
  await m.unmount();
  m = await mount(React.createElement(WorkflowList, listProps({ readOnly: true })), { mobile: true });
  check('   with readOnly there is no New workflow and no selection toggle', !m.host.querySelector('[data-testid="workflow-new"]') && !m.host.querySelector('[title="Select multiple"]'));
  // its hamburger menu
  await tap(m.host.querySelector('[title="Workflow menu"]'));
  let items = texts(document.body);
  check('   its menu keeps the sort order and the exports', items.some((t) => /Date Modified/.test(t)) && items.some((t) => /Export All \(JSON\)/.test(t)), items.join(' | '));
  check('   ...but offers no Variables, New Workflow or Import', !items.some((t) => /^Variables$|New Workflow|Import from/.test(t)), items.join(' | '));
  await m.unmount();

  // ---- 2. the context menu, read-only ----
  const menuProps = (menu, over = {}) => ({ menu, workflows, selectedWorkflows: [], currentMachineId: 'me', onClose() {}, onExportBase64() {}, onExportJson() {}, onBulkMove() {}, onBulkDelete() {}, onDuplicate() {}, onDelete() {}, onAddAIContext() {}, onShare() {}, onStopSharing() {}, onManagePermissions() {}, onShareMany() {}, onStopSharingMany() {}, onManageManyPermissions() {}, ...over });
  m = await mount(React.createElement(WorkflowContextMenu, menuProps({ type: 'single', workflow: workflows[0], x: 10, y: 10 })));
  items = texts(m.host);
  check('2. the desktop single-workflow menu: AI context, duplicate, exports, share, delete', /Add as AI Context/.test(items.join()) && /Duplicate/.test(items.join()) && /Share with the Team/.test(items.join()) && /Delete Workflow/.test(items.join()), items.join(' | '));
  await m.unmount();
  m = await mount(React.createElement(WorkflowContextMenu, menuProps({ type: 'single', workflow: workflows[0], x: 10, y: 10 }, { readOnly: true })), { mobile: true });
  items = texts(m.host);
  check('   read-only: Add as AI Context and the exports stay', /Add as AI Context/.test(items.join()) && /Export Workflow \(JSON\)/.test(items.join()) && /Export as Base64/.test(items.join()), items.join(' | '));
  check('   read-only: no Duplicate, no Share with the Team, no Delete', !/Duplicate|Share with the Team|Sync Changes|Stop Sharing|Manage Permissions|Delete Workflow/.test(items.join()), items.join(' | '));
  check('   the menu is tagged for the phone sheet styling (sc-context-menu)', !!m.host.querySelector('.sc-context-menu'));
  await m.unmount();
  m = await mount(React.createElement(WorkflowContextMenu, menuProps({ type: 'category', category: 'Operations', x: 10, y: 10 }, { readOnly: true })), { mobile: true });
  items = texts(m.host);
  check('   read-only category menu: exports only', items.length === 2 && items.every((t) => /Export Category/.test(t)), items.join(' | '));
  await m.unmount();
  m = await mount(React.createElement(WorkflowContextMenu, menuProps({ type: 'bulk', x: 10, y: 10 }, { selectedWorkflows: [1, 2], readOnly: true })), { mobile: true });
  check('   read-only bulk menu offers nothing (no bulk move or delete)', texts(m.host).length === 0, texts(m.host).join(' | '));
  await m.unmount();

  // ---- 3. the linear reader ----
  const nodes = [
    { id: 'n1', type: 'beginplay', data: {} },
    { id: 'n2', type: 'restapi', data: { method: 'GET', url: 'https://api.example.test/health' } },
    { id: 'n3', type: 'string', data: { value: 'ok' } },
    { id: 'n4', type: 'comparison', data: { operator: '==' } },
    { id: 'n5', type: 'branch', data: {} },
    { id: 'n6', type: 'result', data: {} },
    { id: 'n7', type: 'restapi', data: { method: 'POST', url: 'https://hooks.example.test/alerts' } },
    { id: 'n8', type: 'note', data: { text: 'Runs every five minutes.' } },
    { id: 'n9', type: 'delay', data: { duration: 250 } },
  ];
  const edges = [
    { id: 'e1', source: 'n1', sourceHandle: 'exec-out', target: 'n2', targetHandle: 'exec-in', type: 'execution' },
    { id: 'e2', source: 'n2', sourceHandle: 'exec-out', target: 'n5', targetHandle: 'exec-in', type: 'execution' },
    { id: 'e3', source: 'n2', sourceHandle: 'data-out', target: 'n4', targetHandle: 'left-in', type: 'data' },
    { id: 'e4', source: 'n3', sourceHandle: 'data-out', target: 'n4', targetHandle: 'right-in', type: 'data' },
    { id: 'e8', source: 'n4', sourceHandle: 'data-out', target: 'n5', targetHandle: 'data-in', type: 'data' },
    { id: 'e6', source: 'n5', sourceHandle: 'true', target: 'n6', targetHandle: 'exec-in', type: 'execution' },
    { id: 'e7', source: 'n5', sourceHandle: 'false', target: 'n7', targetHandle: 'exec-in', type: 'execution' },
  ];
  const order = linearize(nodes, edges).map((e) => e.node.id);
  check('3. linearize: the note first, then the execution path from Begin Play, the branch targets, then the unreached nodes (the Comparison - data, evaluated on demand - and the delay), data last', order.join(',') === 'n8,n1,n2,n5,n6,n7,n4,n9,n3', order.join(','));
  const branch = linearize(nodes, edges).find((e) => e.node.id === 'n5');
  check('   a branch carries its TRUE/FALSE outlets with their targets', branch.outlets.map((o) => `${o.caption}:${o.targets.map((t) => t.id).join('+')}`).join(' ') === 'TRUE:n6 FALSE:n7');
  const cmp = linearize(nodes, edges).find((e) => e.node.id === 'n4');
  check('   a node lists the data nodes feeding it', cmp.inputs.map((i) => i.node.id).sort().join(',') === 'n2,n3');
  check('   summarize: a REST node gives its method and URL, a delay its duration', summarize(nodes[1]).chip === 'GET' && summarize(nodes[1]).body === 'https://api.example.test/health' && summarize(nodes[8]).body === '250 ms');
  check('   linearize of nothing is empty; of unknown handles does not throw', linearize([], []).length === 0 && linearize([{ id: 'x', type: 'switch', data: { cases: [{ value: 'a' }] } }], [{ source: 'x', sourceHandle: 'case-0', target: 'y' }]).length === 1);
  m = await mount(React.createElement('div', null, React.createElement(MobileWorkflowToolbar, { isExecuting: false, onRun() {}, onStop() {} }), React.createElement(MobileWorkflowView, { nodes, edges })), { mobile: true });
  const reader = m.host.textContent;
  check('   the reader renders the note, Begin Play, GET + URL, the operator, TRUE/FALSE and the POST target', /Runs every five minutes/.test(reader) && /Begin Play/.test(reader) && /GET/.test(reader) && /api\.example\.test\/health/.test(reader) && /==/.test(reader) && /TRUE/.test(reader) && /FALSE/.test(reader) && /POST/.test(reader) && /hooks\.example\.test/.test(reader), reader.slice(0, 200));
  check('   the toolbar says "View only · edit on desktop" and has Run and Stop', /View only · edit on desktop/.test(reader) && !!m.host.querySelector('[data-testid="mobile-workflow-run"]') && !!m.host.querySelector('[data-testid="mobile-workflow-stop"]'));
  check('   the reader has no inputs or editable fields', m.host.querySelectorAll('input, textarea, select, [contenteditable]').length === 0);
  await m.unmount();

  // ---- 3b. the card bodies: the whole content, not a first line or an ellipsis ----
  const code = 'const body = JSON.parse(input);\nconst items = body.items || [];\nreturn {\n  count: items.length,\n  first: items[0],\n  ok: items.length > 0,\n  names: items.map((i) => i.name),\n};';
  const rich = [
    { id: 'r1', type: 'beginplay', data: {} },
    { id: 'r2', type: 'restapi', data: { method: 'POST', url: 'https://api.example.test/v1/clusters/node-pool-b/evictions?window=15m&includeDetails=true' } },
    { id: 'r3', type: 'transformation', data: { code } },
    { id: 'r4', type: 'ssh', data: { host: 'bastion.example.test', username: 'ops', command: 'kubectl get pods -n shop\nkubectl rollout status deployment/checkout -n shop' } },
    { id: 'r5', type: 'result', data: {} },
  ];
  const richEdges = [
    { id: 'x1', source: 'r1', sourceHandle: 'exec-out', target: 'r2', targetHandle: 'exec-in' },
    { id: 'x2', source: 'r2', sourceHandle: 'exec-out', target: 'r3', targetHandle: 'exec-in' },
    { id: 'x3', source: 'r3', sourceHandle: 'exec-out', target: 'r4', targetHandle: 'exec-in' },
    { id: 'x4', source: 'r4', sourceHandle: 'exec-out', target: 'r5', targetHandle: 'exec-in' },
  ];
  const dT = describe(rich[2]);
  check('3b. describe: a Transform gives its code as lines (monospace), not the first line', dT.chip === 'JS' && dT.mono && dT.lines.length === 8 && dT.lines[0] === 'const body = JSON.parse(input);' && dT.lines[2] === 'return {', JSON.stringify(dT));
  const dR = describe(rich[1]);
  check('   a REST call gives its method and the whole URL (wrapped, never cut)', dR.chip === 'POST' && dR.wrap && dR.lines[0] === rich[1].data.url, JSON.stringify(dR));
  const dS = describe(rich[3]);
  check('   an SSH node gives user@host and every command line', dS.lines[0] === 'ops@bastion.example.test' && dS.lines.length === 3, JSON.stringify(dS));
  check('   every node type the reader knows gives a chip or lines, never undefined', ['delay', 'storage', 'variablereference', 'makearray', 'string', 'integer', 'text', 'boolean', 'object', 'array', 'comparison', 'visualizer', 'result', 'branch', 'switch', 'sequence', 'forloop'].every((type) => { const d = describe({ id: type, type, data: { value: 'v', duration: 5, variableName: 'x', separator: ';', operator: '!=' } }); return Array.isArray(d.lines) && Array.isArray(d.output) && typeof d.chip === 'string' && d.lines.every((l) => typeof l === 'string'); }));
  m = await mount(React.createElement(MobileWorkflowView, { nodes: rich, edges: richEdges }), { mobile: true });
  const bodies = Array.from(m.host.querySelectorAll('[data-testid="mobile-workflow-node-body"]')).map((b) => b.textContent);
  check('   the Transform card shows six lines of the code and a "more" tap for the rest', bodies.some((b) => /const body = JSON\.parse\(input\);/.test(b) && /names: items\.map/.test(b) === false && /… 2 more lines/.test(b)), bodies.join(' || ').slice(0, 300));
  const moreBtn = Array.from(m.host.querySelectorAll('button')).find((b) => /more line/.test(b.textContent));
  await tap(moreBtn);
  check('   ...and the tap shows the whole code', Array.from(m.host.querySelectorAll('[data-testid="mobile-workflow-node-body"]')).some((b) => /names: items\.map/.test(b.textContent)));
  check('   the REST card shows POST and the full URL, not "..."', bodies.some((b) => b === rich[1].data.url) && m.host.textContent.includes('POST') && !/\.\.\.$/.test(bodies.find((b) => /clusters/.test(b)) || ''), bodies.join(' || ').slice(0, 300));
  check('   the SSH card shows user@host and both commands', bodies.some((b) => /ops@bastion\.example\.test/.test(b) && /rollout status/.test(b)));
  check('   still no inputs or editable fields', m.host.querySelectorAll('input, textarea, select, [contenteditable]').length === 0);
  await m.unmount();

  // ---- 3c. the live execution states, as the canvas carries them (node.data.status) ----
  const withStatus = (status, extra = {}) => rich.map((n) => ({ ...n, data: { ...n.data, ...(status[n.id] ? { status: status[n.id], ...(extra[n.id] || {}) } : {}) } }));
  const host2 = document.createElement('div'); document.body.appendChild(host2); const root2 = createRoot(host2);
  const render = async (nodes) => { await act(async () => { root2.render(React.createElement(MobileProvider, null, React.createElement(MobileWorkflowView, { nodes, edges: richEdges }))); }); await sleep(10); };
  await render(withStatus({ r1: 'complete', r2: 'processing' }));
  const states = () => Array.from(host2.querySelectorAll('[data-testid="mobile-workflow-node"]')).map((c) => `${c.getAttribute('data-node-type')}:${c.getAttribute('data-status') || '-'}`).join(' ');
  check('3c. a running node is marked running, a finished one done (the same node.data.status the canvas shows)', states() === 'beginplay:complete restapi:processing transformation:- ssh:- result:-' && /running/.test(host2.textContent) && /done/.test(host2.textContent), states());
  const runningCard = host2.querySelector('[data-status="processing"]');
  check('   the running card carries the processing animation and the blue border, the done card the green one', /workflow-node-processing/.test(runningCard.className) && /border-os-blue/.test(runningCard.className) && /mob-true/.test(host2.querySelector('[data-status="complete"]').className));
  await render(withStatus({ r1: 'complete', r2: 'complete', r3: 'error', r5: 'complete' }, { r3: { error: 'ReferenceError: items is not defined' }, r5: { outputValue: { count: 3, ok: true } } }));
  check('   the states change as the run goes: a failed node says so with its error, a Result shows its output', states() === 'beginplay:complete restapi:complete transformation:error ssh:- result:complete' && /failed/.test(host2.textContent) && /ReferenceError: items is not defined/.test(host2.textContent) && /"count": 3/.test(host2.textContent), states());
  await render(withStatus({}));
  check('   cleared states leave no marks, no outputs', states() === 'beginplay:- restapi:- transformation:- ssh:- result:-' && !/failed|running|done|"count": 3/.test(host2.textContent), states());
  await act(async () => { root2.unmount(); }); host2.remove();
  // the toolbar's Clear
  const tcalls = [];
  m = await mount(React.createElement(MobileWorkflowToolbar, { isExecuting: false, onRun() { tcalls.push('run'); }, onStop() { tcalls.push('stop'); }, onClear() { tcalls.push('clear'); } }), { mobile: true });
  await tap(m.host.querySelector('[data-testid="mobile-workflow-clear"]'));
  check('   the toolbar has Clear next to Stop, calling the same clear as the desktop', tcalls.join(',') === 'clear' && m.host.querySelector('[data-testid="mobile-workflow-clear"]').getAttribute('aria-label') === 'Clear node outputs', tcalls.join(','));
  await m.unmount();
  m = await mount(React.createElement(MobileWorkflowToolbar, { isExecuting: true, onRun() {}, onStop() {}, onClear() {} }), { mobile: true });
  check('   Clear (and Run) are disabled while a run goes, Stop is not', m.host.querySelector('[data-testid="mobile-workflow-clear"]').disabled && m.host.querySelector('[data-testid="mobile-workflow-run"]').disabled && !m.host.querySelector('[data-testid="mobile-workflow-stop"]').disabled);
  await m.unmount();

  // ---- 4. the row chevron ----
  const calls = [];
  const items3 = [{ id: 'a', name: 'Payment service architecture' }, { id: 'b', name: 'Node pool sizing notes' }];
  const list = (mobile) => mount(React.createElement(ItemList, { items: items3, onItemClick: (item) => calls.push(['click', item.id]), onItemContextMenu: (item, e) => calls.push(['menu', item.id, typeof e.preventDefault]) }), { mobile });
  m = await list(false);
  check('4. desktop rows carry no chevron', m.host.querySelectorAll('[data-testid="row-menu-button"]').length === 0);
  await m.unmount();
  m = await list(true);
  const chevrons = m.host.querySelectorAll('[data-testid="row-menu-button"]');
  check('   on a phone every row has one, with a menu role and a 44px minimum target', chevrons.length === 2 && chevrons[0].getAttribute('aria-haspopup') === 'menu' && /min-w-11/.test(chevrons[0].className) && /min-h-11/.test(chevrons[0].className));
  calls.length = 0;
  await tap(chevrons[1]);
  check('   a tap on the chevron opens that row\'s context menu with an event the handler can preventDefault', calls.length === 1 && calls[0][0] === 'menu' && calls[0][1] === 'b' && calls[0][2] === 'function', JSON.stringify(calls));
  check('   ...and does not click (open/select) the row', !calls.some((c) => c[0] === 'click'), JSON.stringify(calls));
  calls.length = 0;
  await tap(m.host.querySelectorAll('.sc-row')[0]);
  check('   a tap on the row itself still opens it', calls.length === 1 && calls[0][0] === 'click' && calls[0][1] === 'a', JSON.stringify(calls));
  await m.unmount();
  const rowCalls = [];
  m = await mount(React.createElement(WorkflowRow, { workflow: workflows[0], isActive: false, isSelected: false, isEditing: false, selectionMode: false, currentMachineId: 'me', onClick: () => rowCalls.push('click'), onDoubleClick() {}, onRename() {}, onStopEditing() {}, onContextMenu: () => rowCalls.push('menu'), onDragStart() {}, onDragEnd() {} }), { mobile: true });
  await tap(m.host.querySelector('[data-testid="row-menu-button"]'));
  check('   WorkflowRow: the chevron opens its menu without opening the workflow', rowCalls.join(',') === 'menu', rowCalls.join(','));
  await m.unmount();
  m = await mount(React.createElement(RowMenuButton, { onOpen: null }), { mobile: true });
  check('   a row without a context menu gets no chevron', m.host.querySelectorAll('button').length === 0);
  await m.unmount();
} catch (error) {
  check('the run completed', false, `${error.message}\n${error.stack}`);
}
fs.rmSync(entry, { force: true });
const ok = summary();
process.exit(ok === false ? 1 : 0);
