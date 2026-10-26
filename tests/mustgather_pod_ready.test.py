#!/usr/bin/env python3
"""
A pod's READY and STATUS as kubectl prints them (backend/parsers/mustgather/detail.py readiness(), read by the Pods
list, the pod detail, the per-node chart and the Findings).

THE BUG: READY was ready statuses / spec containers, with the init containers' statuses mixed in by some readers
and never in the total - an apiserver pod with a finished init container showed "3/2". kubectl counts the regular
containers and the native sidecars (an init container with restartPolicy Always), never an init container that ran
and finished; STATUS names what the first unfinished init container is doing (Init:CrashLoopBackOff, Init:0/2).

Run: backend/venv/bin/python tests/mustgather_pod_ready.test.py
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, 'backend'))
sys.path.insert(0, os.path.join(HERE, 'fixtures', 'diagnostics-mock'))

import mock_mustgather  # noqa: E402
from parsers.mustgather import detail, pod  # noqa: E402

failed = 0


def check(name, passed, info=''):
    global failed
    print(f"{'PASS' if passed else 'FAIL'}: {name}{(' | ' + str(info)[:500]) if info and not passed else ''}")
    if not passed:
        failed += 1


R = detail.readiness

# ---------------------------------------------------------------- crafted pods, kubectl's cases
def mk(containers, init=None, phase='Running', statuses=None, init_statuses=None, conditions=None, deletion=None, reason=None):
    meta = {'name': 'p', 'namespace': 'ns'}
    if deletion:
        meta['deletionTimestamp'] = deletion
    status = {'phase': phase, 'containerStatuses': statuses or [], 'initContainerStatuses': init_statuses or [], 'conditions': conditions or []}
    if reason:
        status['reason'] = reason
    return {'metadata': meta, 'spec': {'containers': [{'name': c} for c in containers], 'initContainers': init or []}, 'status': status}


def cs(name, ready=True, state=None, restarts=0, started=None):
    return {'name': name, 'ready': ready, 'restartCount': restarts, 'started': ready if started is None else started, 'state': state or {'running': {'startedAt': 'x'}}}


DONE = {'terminated': {'exitCode': 0, 'reason': 'Completed'}}
r = R(mk(['api', 'metrics'], init=[{'name': 'fix-permissions'}], statuses=[cs('api'), cs('metrics')], init_statuses=[cs('fix-permissions', ready=False, state=DONE)]))
check("a finished init container and two ready containers: 2/2 Running, init 1/1 done", (r['text'], r['status'], r['init']['done'], r['init']['total']) == ('2/2', 'Running', 1, 1), r)
r = R(mk(['app'], init=[{'name': 'log-shipper', 'restartPolicy': 'Always'}], statuses=[cs('app')], init_statuses=[cs('log-shipper', ready=True)]))
check("a native sidecar (restartPolicy Always, running and ready) counts as a container: 2/2 Running", (r['text'], r['status'], r['init']['sidecars']) == ('2/2', 'Running', ['log-shipper']), r)
r = R(mk(['app'], init=[{'name': 'db-migrate'}], phase='Pending', statuses=[cs('app', ready=False, state={'waiting': {'reason': 'PodInitializing'}})],
         init_statuses=[cs('db-migrate', ready=False, state={'waiting': {'reason': 'CrashLoopBackOff'}}, restarts=6)]))
check("an init container in CrashLoopBackOff: 0/1, Init:CrashLoopBackOff, initializing", (r['text'], r['status'], r['initializing']) == ('0/1', 'Init:CrashLoopBackOff', True), r)
r = R(mk(['a', 'b'], init=[{'name': 'i1'}, {'name': 'i2'}], phase='Pending', init_statuses=[cs('i1', ready=False, state=DONE), cs('i2', ready=False, state={'waiting': {'reason': 'PodInitializing'}})]))
check("the second of two init containers still to run: Init:1/2", (r['text'], r['status'], r['init']['done']) == ('0/2', 'Init:1/2', 1), r)
r = R(mk(['a'], init=[{'name': 'i1'}], phase='Pending', init_statuses=[cs('i1', ready=False, state={'terminated': {'exitCode': 2}})]))
check("an init container that exited 2 without a reason: Init:ExitCode:2", r['status'] == 'Init:ExitCode:2', r)
r = R(mk(['proxy', 'metrics'], statuses=[cs('proxy'), cs('metrics', ready=False)], conditions=[{'type': 'Ready', 'status': 'False'}]))
check("a container not ready: 1/2, STATUS Running (kubectl shows the count, not a NotReady status)", (r['text'], r['status']) == ('1/2', 'Running'), r)
r = R(mk(['job'], phase='Succeeded', statuses=[cs('job', ready=False, state={'terminated': {'exitCode': 0, 'reason': 'Completed'}})]))
check("a pod that ran to the end: 0/1 Completed", (r['text'], r['status']) == ('0/1', 'Completed'), r)
r = R(mk(['w'], statuses=[cs('w', ready=False, state={'waiting': {'reason': 'CrashLoopBackOff'}})]))
check("a regular container in CrashLoopBackOff: 0/1 CrashLoopBackOff", (r['text'], r['status']) == ('0/1', 'CrashLoopBackOff'), r)
r = R(mk(['w'], statuses=[cs('w')], deletion='2026-10-12T14:00:00Z'))
check("a pod being deleted: Terminating", r['status'] == 'Terminating', r)
r = R(mk(['a', 'b'], statuses=[cs('a'), cs('b'), cs('ghost')]))
check("a status the spec has no container for never raises READY past the total (no 3/2)", r['text'] == '2/2', r)
r = R(mk(['a'], init=[{'name': 'i1'}], statuses=[cs('a')], init_statuses=[cs('i1', ready=True, state=DONE)]))
check("a finished init container reported ready is still not counted: 1/1", r['text'] == '1/1', r)

# ---------------------------------------------------------------- through the fixture and the parser
WORK = tempfile.mkdtemp(prefix="mg-pod-ready-")
GATHER = os.path.join(WORK, "must-gather.local.1234567890")
mock_mustgather.build(GATHER)
res = pod.parse(GATHER)
demo = res['demo-app']


def row(name):
    p = demo[name]
    return p['_ready']['text'], p['_ready']['status'], p['_detail']['summary']['ready'], p['_detail']['badge'], p['_detail']['summary']['init']


t, s, sr, badge, init = row('demo-api-7c8d9e0f1-init0')
check("fixture: the finished init container pod: 2/2 Running, the summary and badge agree, init 1/1 done", t == '2/2' and s == 'Running' and sr == '2/2' and badge == {'kind': 'ok', 'text': 'Running'} and (init['done'], init['total']) == (1, 1), (t, s, sr, badge, init))
t, s, sr, badge, init = row('demo-sidecar-5a6b7c8d9-side0')
check("fixture: the sidecar pod: 2/2 Running, the sidecar named", t == '2/2' and s == 'Running' and badge['kind'] == 'ok' and init['sidecars'] == ['log-shipper'], (t, s, badge, init))
t, s, sr, badge, init = row('demo-migrate-1a2b3c4d5-crash')
d = demo['demo-migrate-1a2b3c4d5-crash']['_detail']
check("fixture: the init-crash pod: 0/1, Init:CrashLoopBackOff, a bad badge, the init card not done with 6 restarts", t == '0/1' and s == 'Init:CrashLoopBackOff' and badge == {'kind': 'bad', 'text': 'Init:CrashLoopBackOff'} and (init['done'], init['total']) == (0, 1)
      and any(c['init'] and not c['sidecar'] and c['state']['kind'] == 'waiting' and c['state']['reason'] == 'CrashLoopBackOff' and c['restarts'] == 6 for c in d['containers']), (t, s, badge, init))
check("fixture: the init-crash pod's own findings: db-migrate is in CrashLoopBackOff (bad), 6 restarts", any(f['title'] == 'db-migrate is in CrashLoopBackOff' and f['severity'] == 'bad' for f in d['findings']) and any(f['title'] == 'db-migrate restarted 6 times' for f in d['findings']), [f['title'] for f in d['findings']])
t, s, sr, badge, init = row('demo-proxy-9f8e7d6c5-half0')
check("fixture: the half-ready pod: 1/2 Running, the badge says Running, 1/2 ready", t == '1/2' and s == 'Running' and badge == {'kind': 'warn', 'text': 'Running, 1/2 ready'}, (t, s, badge))
t, s, sr, badge, init = row('demo-web-7d9f8b6c5-abcde')
check("fixture: a plain healthy pod: 1/1 Running, no init containers", t == '1/1' and s == 'Running' and init['total'] == 0, (t, s, init))
crash = res['payments-demo']['payments-worker-7b8c9d0e1-efghi']
check("fixture: the crash-looping pod (a regular container): 0/1 CrashLoopBackOff, as before", (crash['_ready']['text'], crash['_ready']['status']) == ('0/1', 'CrashLoopBackOff'), crash['_ready'])
titles = [f['title'] for f in pod.findings(GATHER)]
check("the page's Findings: the init-crash pod is in Init:CrashLoopBackOff (bad) with the Log Viewer link, the proxy pod is not a crash", any(t_ == 'demo-app/demo-migrate-1a2b3c4d5-crash is in Init:CrashLoopBackOff' for t_ in titles) and not any('demo-proxy' in t_ for t_ in titles), titles)
nodes = {n['name']: n for n in res['_nodes']['rows']} if isinstance(res.get('_nodes'), dict) else {}
check("pods per node: the init-crash pod counts as Failed on worker-0", (nodes.get('worker-0') or {}).get('phases', {}).get('Failed', 0) >= 1, nodes.get('worker-0'))
shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
