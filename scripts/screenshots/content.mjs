// Synthetic, generic content for the marketing screenshots. Nothing here is
// real: example.test hosts, fictional teammates, invented dates (Oct 2026).

export const ACCOUNT = { username: 'priya', password: 'correct horse battery staple', displayName: 'Priya Natarajan' };

/** The documents open in the tab strip (first = current) and the one with the Mermaid diagram. */
export const OPEN_DOCUMENTS = ['Kubernetes upgrade runbook', 'Incident review: API latency', 'Postgres failover checklist'];
export const MERMAID_DOCUMENT = 'Payment service architecture';
/** The document shown in the right pane of the split-view shot (the first open document stays on the left). */
export const SPLIT_RIGHT_DOCUMENT = 'Payment service architecture';

export const CATEGORIES = [
  { name: 'Runbooks', icon: 'procedures' },
  { name: 'Incidents', icon: 'cases' },
  { name: 'Checklists', icon: 'templates' },
  { name: 'Architecture', icon: 'lab' },
  { name: 'Meetings', icon: 'meetings' },
];

const DAY = 24 * 3600 * 1000;
const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h, 0, 0).getTime();

export const DOCUMENTS = [
  {
    title: 'Kubernetes upgrade runbook',
    category: 'Runbooks',
    updatedAt: at(2026, 10, 13, 16),
    content: `# Kubernetes upgrade runbook

Step-by-step procedure for moving a cluster from **1.33** to **1.34** with zero customer-facing downtime. Run it on staging first, then production, one node pool at a time.

## Before you start

- [x] Read the 1.34 release notes and the deprecation list
- [x] Confirm the etcd snapshot from last night restored cleanly
- [ ] Announce the maintenance window in #platform-ops
- [ ] Freeze deployments for the duration of the upgrade

## Preflight

Check that every node is healthy and that no pod is stuck in a non-running state:

\`\`\`bash
# one pool at a time - never drain two nodes at once
export POOL="node-pool-a"
kubectl get nodes -l pool="$POOL" -o wide
kubectl get pods -A --field-selector=status.phase!=Running
kubectl drain "\${POOL}-01" --ignore-daemonsets --delete-emptydir-data
\`\`\`

## Node pool order

| Pool | Nodes | Workloads | Window |
|------|-------|-----------|--------|
| control-plane | 3 | API server, scheduler | 09:00 - 09:40 |
| node-pool-a | 6 | web, api, checkout | 10:00 - 11:30 |
| node-pool-b | 4 | batch, reporting | 13:00 - 14:00 |
| node-pool-gpu | 2 | ml-inference | 15:00 - 15:30 |

## Rollout

Upgrade the control plane first, then each pool. Between pools, verify that the rollout is complete before moving on:

\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: shop
spec:
  strategy:
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
\`\`\`

> **Tip:** keep \`kubectl get events -A --watch\` open in a second terminal while a pool is draining.

## Verification

1. All nodes report \`Ready\` on the new version
2. Synthetic checks pass for the storefront and the API
3. Error budget burn rate is below 2x for 30 minutes

## Rollback

If any verification step fails, re-image the affected pool from the previous node image and restore the etcd snapshot. See [Postgres failover checklist](#) for the database side.
`,
  },
  {
    title: 'Incident review: API latency',
    category: 'Incidents',
    updatedAt: at(2026, 10, 12, 11),
    content: `# Incident review: API latency

**Date:** 2026-10-09 · **Duration:** 47 minutes · **Severity:** 2 · **Owner:** Jordan

## Summary

Between 14:02 and 14:49 UTC the public API's p99 latency rose from 180 ms to over 4 s. About 12% of checkout requests timed out. The cause was a connection-pool exhaustion in the \`orders\` service after a dependency started returning slowly.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 14:02 | Latency alert fires for \`api-gateway\` |
| 14:06 | Alex acknowledges, starts looking at traces |
| 14:15 | Pool exhaustion identified in \`orders\` |
| 14:31 | Pool size raised, circuit breaker enabled |
| 14:49 | p99 back under 250 ms, incident closed |

## Contributing factors

- The \`inventory\` dependency had no timeout configured on the client side
- Pool size was tuned for last year's traffic
- The dashboard for pool usage was not linked from the alert

## What went well

- Tracing pointed at the right service within ten minutes
- The circuit breaker could be enabled without a deploy

## Action items

- [ ] Add a 800 ms client timeout to every call into \`inventory\` (Sam)
- [ ] Alert on pool usage above 80% (Priya)
- [x] Link the pool dashboard from the latency alert (Alex)
- [ ] Load-test the new pool size before the holiday peak (Jordan)
`,
  },
  {
    title: 'Postgres failover checklist',
    category: 'Checklists',
    updatedAt: at(2026, 10, 11, 9),
    content: `# Postgres failover checklist

Use this when the primary at \`db-primary.example.test\` is unhealthy and the replica has to take over.

## Decide

- [x] Confirm the primary is really down (not just the monitor)
- [x] Check replication lag on the replica is under 5 seconds
- [ ] Tell the on-call lead before promoting

## Promote

\`\`\`bash
ssh ops@db-replica.example.test
sudo -u postgres pg_ctl promote -D /var/lib/pgsql/data
psql -c "SELECT pg_is_in_recovery();"   # expect: f
\`\`\`

## Repoint

- [ ] Update the \`primary\` DNS record to the new host
- [ ] Restart the connection pooler
- [ ] Watch error rates for five minutes

## Afterwards

- [ ] Rebuild the old primary as a replica
- [ ] Write the incident note
`,
  },
  {
    title: 'TLS certificate rotation',
    category: 'Runbooks',
    updatedAt: at(2026, 10, 8, 15),
    content: `# TLS certificate rotation

Certificates on the edge gateway expire every 90 days. Rotate them two weeks before expiry.

## Steps

1. Issue the new certificate with the internal CA
2. Upload it to the gateway's secret store
3. Reload the gateway, one instance at a time

\`\`\`bash
openssl x509 -in gateway.crt -noout -enddate
kubectl create secret tls gateway-tls --cert=gateway.crt --key=gateway.key --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/edge-gateway -n ingress
\`\`\`

## Verify

| Check | Command |
|-------|---------|
| Expiry | \`openssl s_client -connect edge.example.test:443\` |
| Chain | \`curl -vI https://edge.example.test\` |
`,
  },
  {
    title: 'Payment service architecture',
    category: 'Architecture',
    updatedAt: at(2026, 10, 10, 13),
    content: `# Payment service architecture

How a checkout request flows through the platform, and where the retries and timeouts live.

## Request flow

\`\`\`mermaid
flowchart LR
    Client([Browser]) --> GW[Edge gateway]
    GW --> API[API gateway]
    API --> Orders[orders service]
    Orders --> Inventory[(inventory)]
    Orders --> Payments[payments service]
    Payments --> PSP{{Payment provider}}
    Orders --> Queue[[events queue]]
    Queue --> Notify[notifications]
\`\`\`

## Timeouts and retries

| Hop | Timeout | Retries | Circuit breaker |
|-----|---------|---------|-----------------|
| gateway → API | 10 s | 0 | no |
| API → orders | 3 s | 1 | yes |
| orders → inventory | 800 ms | 2 | yes |
| orders → payments | 5 s | 0 | yes |

## Notes

- The events queue is the only asynchronous hop; everything else is request/response.
- \`payments\` is the only service allowed to talk to the provider.
`,
  },
  {
    title: 'Weekly platform sync - 2026-10-13',
    category: 'Meetings',
    updatedAt: at(2026, 10, 13, 10),
    content: `# Weekly platform sync - 2026-10-13

**Attendees:** Alex, Sam, Priya, Jordan

## Agenda

1. Upgrade to Kubernetes 1.34 - staging done, production next week
2. Incident review follow-ups
3. Q4 roadmap

## Decisions

- Production upgrade on Tuesday, node-pool-a first
- Priya owns the alerting work for pool usage

## Actions

- [ ] Sam: client timeouts for \`inventory\`
- [ ] Jordan: load test before the holiday peak
`,
  },
  {
    title: 'Node pool sizing notes',
    category: 'Architecture',
    updatedAt: at(2026, 10, 6, 17),
    content: `# Node pool sizing notes

Current and proposed sizes for each pool, based on the September traffic review.

| Pool | Now | Proposed | Reason |
|------|-----|----------|--------|
| node-pool-a | 6 | 8 | checkout headroom |
| node-pool-b | 4 | 4 | unchanged |
| node-pool-gpu | 2 | 3 | inference backlog |
`,
  },
  {
    title: 'On-call handover',
    category: 'Meetings',
    updatedAt: at(2026, 10, 12, 18),
    content: `# On-call handover

## Open items

- Pod evictions on node-pool-b: watching memory pressure, no page yet
- Certificate rotation due on the 15th

## Quiet since

- Nothing paged over the weekend
`,
  },
];

export const KANBAN = {
  title: 'Platform Q4 roadmap',
  category: 'Platform',
  createdAt: at(2026, 10, 1, 9),
  updatedAt: at(2026, 10, 13, 17),
  columns: [
    { id: 'col-backlog', title: 'Backlog', color: '#8b5cf6' },
    { id: 'col-progress', title: 'In progress', color: '#3b82f6' },
    { id: 'col-done', title: 'Done', color: '#22c55e' },
  ],
  cards: [
    { status: 'col-backlog', title: 'Replace deprecated ingress annotations', description: 'Move every ingress to the v1 annotation set before 1.35.', assignee: 'Sam', priority: 'medium', dueDate: '2026-10-28', tags: ['kubernetes'] },
    { status: 'col-backlog', title: 'Load-test the new connection pool size', description: '', assignee: 'Jordan', priority: 'high', dueDate: '2026-11-04', tags: ['performance', 'orders'] },
    { status: 'col-backlog', title: 'Document the GPU pool autoscaler', description: '', assignee: 'Priya', priority: 'low', dueDate: '', tags: ['docs'] },
    { status: 'col-progress', title: 'Upgrade production to Kubernetes 1.34', description: 'Staging done. Production on Tuesday, node-pool-a first.', assignee: 'Alex', priority: 'urgent', dueDate: '2026-10-20', tags: ['kubernetes', 'upgrade'] },
    { status: 'col-progress', title: 'Client timeouts for inventory calls', description: 'PR open, waiting on a second review.', assignee: 'Sam', priority: 'high', dueDate: '2026-10-16', tags: ['orders', 'resilience'] },
    { status: 'col-progress', title: 'Rotate edge gateway certificates', description: '', assignee: 'Jordan', priority: 'medium', dueDate: '2026-10-15', tags: ['tls'] },
    { status: 'col-done', title: 'Alert on connection pool usage above 80%', description: '', assignee: 'Priya', priority: 'high', dueDate: '2026-10-13', tags: ['alerting'] },
    { status: 'col-done', title: 'Link pool dashboard from the latency alert', description: '', assignee: 'Alex', priority: 'medium', dueDate: '2026-10-10', tags: ['alerting'] },
    { status: 'col-done', title: 'etcd snapshot restore drill', description: '', assignee: 'Priya', priority: 'low', dueDate: '2026-10-07', tags: ['kubernetes'] },
  ],
};

export const WORKFLOW = {
  title: 'Health check and notify',
  category: 'Operations',
  createdAt: at(2026, 10, 5, 11),
  updatedAt: at(2026, 10, 13, 15),
  nodes: [
    { id: 'node-1', type: 'beginplay', position: { x: 40, y: 190 }, data: {} },
    { id: 'node-2', type: 'restapi', position: { x: 370, y: 150 }, data: { url: 'https://api.example.test/health', method: 'GET', headers: '{"Accept": "application/json"}', body: '' } },
    { id: 'node-3', type: 'string', position: { x: 370, y: 520 }, data: { value: 'ok' } },
    { id: 'node-4', type: 'comparison', position: { x: 780, y: 400 }, data: { operator: '==' } },
    { id: 'node-5', type: 'branch', position: { x: 1110, y: 150 }, data: {} },
    { id: 'node-6', type: 'result', position: { x: 1640, y: 20 }, data: {} },
    { id: 'node-7', type: 'restapi', position: { x: 1640, y: 175 }, data: { url: 'https://hooks.example.test/alerts', method: 'POST', headers: '{"Content-Type": "application/json"}', body: '{"text": "API health check failed"}' } },
    { id: 'node-8', type: 'note', position: { x: 40, y: 40 }, data: { text: 'Runs every five minutes. Pages on-call when the health endpoint stops answering ok.', color: 'yellow' } },
  ],
  edges: [
    { id: 'e1', source: 'node-1', sourceHandle: 'exec-out', target: 'node-2', targetHandle: 'exec-in', type: 'execution' },
    { id: 'e2', source: 'node-2', sourceHandle: 'exec-out', target: 'node-5', targetHandle: 'exec-in', type: 'execution' },
    { id: 'e3', source: 'node-2', sourceHandle: 'data-out', target: 'node-4', targetHandle: 'left-in', type: 'data' },
    { id: 'e4', source: 'node-3', sourceHandle: 'data-out', target: 'node-4', targetHandle: 'right-in', type: 'data' },
    { id: 'e5', source: 'node-4', sourceHandle: 'data-out', target: 'node-5', targetHandle: 'data-in', type: 'data' },
    { id: 'e6', source: 'node-5', sourceHandle: 'true', target: 'node-6', targetHandle: 'exec-in', type: 'execution' },
    { id: 'e7', source: 'node-5', sourceHandle: 'false', target: 'node-7', targetHandle: 'exec-in', type: 'execution' },
  ],
};

export const CALENDARS = [
  { id: 'platform-team@example.test', summary: 'Platform team', backgroundColor: '#7c3aed', foregroundColor: '#ffffff' },
  { id: 'on-call@example.test', summary: 'On-call', backgroundColor: '#f59e0b', foregroundColor: '#ffffff' },
];

// week of Mon 2026-10-12 .. Sun 2026-10-18 (today is Wed 2026-10-14)
const ev = (cal, id, summary, d, h1, m1, h2, m2, extra = {}) => {
  const start = new Date(2026, 9, d, h1, m1, 0, 0);
  const end = new Date(2026, 9, d, h2, m2, 0, 0);
  return {
    id: `${cal}_${id}`, calendarId: cal, eventId: id, summary, description: extra.description || '',
    start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, location: extra.location || '',
    attendees: extra.attendees || [], recurrence: null, creator: null, organizer: null, status: 'confirmed', htmlLink: '',
    lastFetched: Date.now(), startDateTime: start.getTime(), endDateTime: end.getTime(), isAllDay: false,
  };
};
const allDay = (cal, id, summary, d1, d2) => ({
  id: `${cal}_${id}`, calendarId: cal, eventId: id, summary, description: '',
  start: { date: `2026-10-${String(d1).padStart(2, '0')}` }, end: { date: `2026-10-${String(d2).padStart(2, '0')}` }, location: '',
  attendees: [], recurrence: null, creator: null, organizer: null, status: 'confirmed', htmlLink: '',
  lastFetched: Date.now(), startDateTime: new Date(2026, 9, d1).getTime(), endDateTime: new Date(2026, 9, d2).getTime(), isAllDay: true,
});
const T = 'platform-team@example.test';
const O = 'on-call@example.test';
export const EVENTS = [
  ev(T, 'standup-mon', 'Platform stand-up', 12, 9, 30, 9, 45),
  ev(T, 'sync-mon', 'Weekly platform sync', 12, 10, 0, 11, 0, { location: 'Room 4B' }),
  ev(T, 'k8s-staging', 'Staging upgrade: Kubernetes 1.34', 12, 13, 0, 15, 30),
  ev(T, 'standup-tue', 'Platform stand-up', 13, 9, 30, 9, 45),
  ev(T, 'incident-review', 'Incident review: API latency', 13, 11, 0, 12, 0),
  ev(T, 'pairing', 'Pairing: alert rules with Priya', 13, 14, 0, 15, 0),
  ev(T, 'standup-wed', 'Platform stand-up', 14, 9, 30, 9, 45),
  ev(T, 'design-review', 'Design review: payments retries', 14, 11, 0, 12, 0),
  ev(T, 'focus', 'Focus time: upgrade runbook', 14, 13, 30, 16, 0),
  ev(T, 'standup-thu', 'Platform stand-up', 15, 9, 30, 9, 45),
  ev(T, 'tls-rotate', 'TLS certificate rotation', 15, 10, 0, 11, 30),
  ev(T, 'roadmap', 'Q4 roadmap planning', 15, 14, 0, 16, 0, { location: 'Room 2A' }),
  ev(T, 'standup-fri', 'Platform stand-up', 16, 9, 30, 9, 45),
  ev(T, 'demo', 'Sprint demo', 16, 11, 0, 12, 0),
  ev(T, 'retro', 'Retrospective', 16, 15, 0, 16, 0),
  ev(O, 'handover', 'On-call handover', 12, 17, 0, 17, 30),
  ev(O, 'drill', 'Postgres failover drill', 14, 16, 30, 17, 30),
  allDay(O, 'oncall-week', 'On-call: Jordan', 12, 19),
  allDay(T, 'freeze', 'Deployment freeze', 15, 17),
];

export const TASKS = [
  ['Upgrade production cluster to Kubernetes 1.34', 'project:platform', 'priority:H', 'due:2026-10-20', '+kubernetes', '+upgrade'],
  ['Rotate TLS certificates on the edge gateway', 'project:security', 'priority:H', 'due:2026-10-15', '+tls'],
  ['Investigate pod evictions on node-pool-b', 'project:platform', 'priority:H', 'due:2026-10-16', '+kubernetes'],
  ['Add client timeouts to inventory calls', 'project:orders', 'priority:M', 'due:2026-10-17', '+resilience'],
  ['Alert on connection pool usage above 80%', 'project:observability', 'priority:M', 'due:2026-10-17', '+alerting'],
  ['Write the Postgres failover checklist', 'project:database', 'priority:M', 'due:2026-10-21', '+docs', '+postgres'],
  ['Load-test the new connection pool size', 'project:orders', 'priority:M', 'due:2026-11-04', '+performance'],
  ['Tune HPA thresholds for the checkout service', 'project:platform', 'priority:L', 'due:2026-10-23', '+kubernetes'],
  ['Replace deprecated ingress annotations', 'project:platform', 'priority:L', 'due:2026-10-28', '+kubernetes'],
  ['Archive the Q3 on-call handover notes', 'project:ops', 'priority:L'],
  ['Review Grafana alert rules with Priya', 'project:observability', 'priority:M', 'due:2026-10-19', '+grafana'],
  ['Draft the incident review for the API latency incident', 'project:incidents', 'priority:H', 'due:2026-10-12'],
];

/** Taskwarrior actions after the adds: [task number, ...arguments]. */
export const TASK_ACTIONS = [
  [3, 'start'],
  [12, 'done'],
  [1, 'annotate', 'Staging went fine on Monday; production on Tuesday.'],
];
export const TASK_INSTANCE = { name: 'Platform work', category: 'General', description: 'Day-to-day platform tasks' };
export const TASK_REPORTS = [
  { name: 'Due this week', category: 'Planning', description: 'Everything due before next Monday', filter: 'due.before:2026-10-19' },
  { name: 'High priority', category: 'Planning', description: 'Priority H, any project', filter: 'priority:H' },
  { name: 'Kubernetes', category: 'Planning', description: 'Tagged kubernetes', filter: '+kubernetes' },
];

export const CHAT = {
  id: 1760000000000,
  name: 'Debugging a stuck rollout',
  createdAt: '2026-10-13T14:02:00.000Z',
  settings: { provider: 'ollama', model: 'llama3.1:8b', temperature: 0, maxTokens: 2000 },
  messages: [
    { role: 'user', content: 'My deployment `checkout` in namespace `shop` has been stuck at 3/4 ready for twenty minutes after I bumped the image. Where do I start?' },
    { role: 'assistant', content: `Start by finding out which pod is not becoming ready and why. Three commands usually tell the whole story:

\`\`\`bash
kubectl rollout status deployment/checkout -n shop
kubectl get pods -n shop -l app=checkout
kubectl describe pod <pending-pod> -n shop | tail -n 30
\`\`\`

Look at the **Events** section at the bottom of \`describe\`. The common causes, in order of how often I see them:

1. **Readiness probe failing** - the new image listens on a different port or path, or starts slower than \`initialDelaySeconds\` allows.
2. **ImagePullBackOff** - the tag does not exist in the registry, or the pull secret is missing on that node.
3. **Insufficient resources** - the pod is \`Pending\` because no node has room for the new requests.

If it is the readiness probe, the fix is usually in the deployment spec rather than the image:

\`\`\`yaml
readinessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 15
  periodSeconds: 5
\`\`\`

Tell me what the events say and I can narrow it down.` },
    { role: 'user', content: 'Events say "Readiness probe failed: Get http://10.0.0.17:8080/healthz: dial tcp: connection refused". The old image used port 8080 too.' },
    { role: 'assistant', content: `"Connection refused" means nothing is listening on 8080 inside the container *yet* (or at all), so it is not the probe path - it is the process. Two things to check:

- **Startup time.** Exec in and see whether the port opens after a while:

  \`\`\`bash
  kubectl exec -n shop <pod> -- sh -c 'sleep 20; wget -qO- http://127.0.0.1:8080/healthz'
  \`\`\`

  If that succeeds, the new image just starts slower. Raise \`initialDelaySeconds\` or add a \`startupProbe\` with a generous \`failureThreshold\`.

- **Bind address.** If the new build reads \`PORT\` or \`HOST\` from the environment and the default changed, the server may be listening on \`127.0.0.1\` only. Check the container logs for the line that says where it is listening.

Since the rollout is paused at \`maxUnavailable: 0\`, the old pods are still serving traffic, so there is no rush. When you have the fix, \`kubectl rollout restart\` is not needed - just apply the corrected spec and the rollout continues.` },
  ],
};
