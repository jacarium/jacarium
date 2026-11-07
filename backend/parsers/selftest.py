"""`flask-backend --selftest-parallel` (app_standalone.py): proof that a backend - the frozen one above all - can
run work in worker processes (parsers/parallel.py), without starting the app.

Runs a small job through the pool with 3 workers, then the Log Collection Histogram over three small synthetic
journals (documentation addresses, .test names) with 3 workers forced, and prints one JSON object:
    {"ok", "frozen", "parent_pid", "pool": {mode, workers, fallback, pids}, "histogram": {mode, workers, fallback,
     lines, templates, anomalies}, "identical": serial == parallel}
Exit status 0 when both ran in worker processes and matched a serial run, 1 otherwise (a fallback included).
"""
import json
import os
import shutil
import sys
import tempfile


def _probe(x):
    """One item of the pool job: its square and the worker's pid (a module-level function: picklable)."""
    return {'x': x, 'square': x * x, 'pid': os.getpid()}


def _journal(path, seed):
    import random
    from datetime import datetime, timedelta
    rnd = random.Random(seed)
    t0 = datetime(2026, 10, 12, 0, 0, 0)
    with open(path, 'w', encoding='utf-8') as f:
        for i in range(3000):
            dt = t0 + timedelta(seconds=i * 20)
            proc = rnd.choice(['sshd', 'kernel', 'example-worker'])
            f.write(f"{dt.strftime('%b')} {dt.day:2d} {dt.strftime('%H:%M:%S')} node-01.example.test {proc}[{rnd.randint(100, 9999)}]: "
                    f"session {rnd.randint(1, 999)} from 192.0.2.{rnd.randint(1, 254)} done in {rnd.randint(1, 900)} ms\n")


def main():
    from parsers import parallel
    from parsers import log_histogram as engine
    out = {'ok': False, 'frozen': bool(getattr(sys, 'frozen', False)), 'parent_pid': os.getpid()}
    info = {}
    res = parallel.run(_probe, list(range(12)), workers=3, info=info)
    pids = sorted({r['pid'] for r in res})
    out['pool'] = dict(info, pids=pids, results_ok=[r['square'] for r in res] == [x * x for x in range(12)])
    work = tempfile.mkdtemp(prefix='jacarium-selftest-')
    try:
        sources = []
        for k in range(3):
            p = os.path.join(work, f'journal-{k}.log')
            _journal(p, k)
            sources.append({'path': p, 'size': os.path.getsize(p), 'kind': 'auto', 'prefix': '', 'label': f'journal-{k}', 'link': f'journal-{k}', 'year': 2026, 'ref': None})
        par = engine.analyse(engine.plan_items(sources), workers=3)
        ser = engine.analyse(engine.plan_items(sources), workers=1)
        strip = lambda r: json.dumps({k: v for k, v in r.items() if k not in ('stats', 'findings')}, sort_keys=True)  # noqa: E731
        run = par['stats']['run']
        out['histogram'] = {'mode': run.get('mode'), 'workers': run.get('workers'), 'fallback': run.get('fallback'),
                            'lines': par['stats']['lines'], 'templates': par['stats']['templates'], 'anomalies': len(par['anomalies'])}
        out['identical'] = strip(par) == strip(ser)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    out['alive_after'] = len(parallel.alive_workers())
    out['ok'] = (out['pool']['mode'] == 'parallel' and out['pool']['results_ok'] and os.getpid() not in pids and len(pids) >= 2
                 and out['histogram']['mode'] == 'parallel' and out['identical'] and out['alive_after'] == 0)
    print(json.dumps(out))
    sys.stdout.flush()
    return 0 if out['ok'] else 1
