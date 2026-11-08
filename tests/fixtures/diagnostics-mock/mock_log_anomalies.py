"""SYNTHETIC logs with planted anomalies, for the Log Collection Histogram (backend/parsers/log_histogram.py).

Every value is invented: host node-01.example.test, documentation addresses (192.0.2.0/24, 198.51.100.0/24,
203.0.113.0/24), .test / example names, random ids from a fixed seed. Deterministic for a seed.

    write_planted_journal(path, per_minute=60, seed=7, flat=False) -> ground truth
        One day (2026-10-12) of a journal in journalctl's short form: a dozen routine messages at a daily swing,
        a heartbeat every minute, and - unless flat - six planted anomalies (PLANTED). flat=True is the control:
        the same routine traffic and heartbeat (which never stops), nothing planted.
    planted_sosreport(base, per_minute=60, seed=7, flat=False) -> (report dir, ground truth)
        The journal inside a minimal sosreport tree (sos_commands/logs/journalctl_--no-pager, the `date` capture).
    planted_mustgather(base, pods=12, lines_per_pod=4000, seed=11, flat=False) -> (gather dir, ground truth)
        A must-gather tree with container logs (CRI format) and a node journal: a burst in one container, a new
        error in another, a crash loop's previous log, routine traffic elsewhere.

Ground truth: [{'kind': ..., 'at': 'HH:MM', 'text': a substring of the planted message}].
"""
import math
import os
import random
from datetime import datetime, timedelta

DAY = datetime(2026, 10, 12, 0, 0, 0)
HOST = 'node-01.example.test'

# the anomalies planted in the journal (minutes of the day), checked by tests/log_histogram.test.py
PLANTED = [
    {'kind': 'errors', 'at': '06:00', 'text': 'Failed password for invalid user admin'},      # an error-rate spike, 30 min
    {'kind': 'volume', 'at': '10:00', 'text': ''},                                              # a volume spike, 5 min
    {'kind': 'burst', 'at': '14:00', 'text': 'nfs: server nfs01.example.test not responding'},  # a burst, 20 min
    {'kind': 'rare', 'at': '16:33', 'text': 'BUG: soft lockup'},                                # once, critical-ish
    {'kind': 'new', 'at': '18:00', 'text': 'XFS (dm-3): metadata I/O error'},                   # new from 18:00
    {'kind': 'stopped', 'at': '20:00', 'text': 'PLEG is healthy'},                              # the heartbeat stops
]


def _ip(rnd):
    return f"{rnd.choice(['192.0.2', '198.51.100', '203.0.113'])}.{rnd.randint(1, 254)}"


def _routine(rnd):
    return [  # (process, weight, message factory)
        ('nginx', 10, lambda: f'{_ip(rnd)} - - "GET /api/v1/items/{rnd.randint(1, 99999)} HTTP/1.1" 200 {rnd.randint(100, 9000)} "-" "curl/8.0"'),
        ('example-worker', 6, lambda: f'info: queue payments depth={rnd.randint(1, 500)} workers=64 lag_ms={rnd.randint(1, 5000)}'),
        ('systemd', 1, lambda: f'Started Session {rnd.randint(1, 9999)} of User core.'),
        ('systemd-logind', 1, lambda: f'New session {rnd.randint(1, 9999)} of user core.'),
        ('sshd', 1, lambda: f'Accepted publickey for core from {_ip(rnd)} port {rnd.randint(30000, 65000)} ssh2: ED25519 SHA256:{rnd.getrandbits(64):016x}'),
        ('sshd', 0.3, lambda: f'Failed password for invalid user admin from {_ip(rnd)} port {rnd.randint(30000, 65000)} ssh2'),
        ('kernel', 0.5, lambda: f'IPv4: martian source {_ip(rnd)} from {_ip(rnd)}, on dev eth0'),
        ('chronyd', 0.2, lambda: f'Selected source {_ip(rnd)} (ntp{rnd.randint(1, 4)}.example.test)'),
        ('crond', 0.5, lambda: f'(root) CMD (/usr/local/bin/backup.sh --target /srv/backup/{rnd.randint(1, 30)})'),
        ('kernel', 0.05, lambda: 'nfs: server nfs01.example.test not responding, still trying'),
        ('containerd', 2, lambda: f'time="2026-10-12T00:00:00Z" level=info msg="container {rnd.getrandbits(128):032x} started" namespace=k8s.io'),
        ('example-api', 1, lambda: f'WARN request {rnd.getrandbits(32):08x}-{rnd.getrandbits(16):04x} slow: {rnd.randint(500, 3000)}ms path=/api/v1/orders/{rnd.randint(1, 9999)}'),
    ]


def _short_ts(dt):
    return f"{dt.strftime('%b')} {dt.day:2d} {dt.strftime('%H:%M:%S')}"


def write_planted_journal(path, per_minute=60, seed=7, flat=False, days=1):
    """`days` > 1: the routine traffic over that many days from DAY, the anomalies planted on the first day only."""
    rnd = random.Random(seed)
    routine = _routine(rnd)
    weights = [r[1] for r in routine]
    events = []
    for absolute in range(days * 24 * 60):
        t0 = DAY + timedelta(minutes=absolute)
        minute = absolute if absolute < 24 * 60 else -1   # the plants below: the first day only
        hour = (absolute % 1440) / 60
        rate = per_minute * (1.0 + 0.4 * math.sin((hour - 9) / 24 * 2 * math.pi) ** 2)   # a daily swing
        k = max(0, int(rnd.gauss(rate, math.sqrt(rate))))
        msgs = []
        for _ in range(k):
            proc, _w, f = rnd.choices(routine, weights=weights)[0]
            msgs.append((proc, f()))
        heartbeat = flat or 0 <= minute < 1200
        if heartbeat:
            msgs.append(('kubelet', f'I{t0.strftime("%m%d")} {t0.strftime("%H:%M:%S")}.000000 {rnd.randint(1000, 9999)} kubelet.go:2400] "PLEG is healthy" relist_ms={rnd.randint(1, 90)}'))
        if not flat:
            if 360 <= minute < 390:   # errors 06:00-06:30
                msgs += [('sshd', f'Failed password for invalid user admin from {_ip(rnd)} port {rnd.randint(30000, 65000)} ssh2') for _ in range(int(per_minute * 0.03 * 8) + 2)]
            if 600 <= minute < 605:   # volume 10:00-10:05
                msgs += [('nginx', routine[0][2]()) for _ in range(int(per_minute * 1.2 * 12))]
            if 840 <= minute < 860:   # burst 14:00-14:20
                msgs += [('kernel', 'nfs: server nfs01.example.test not responding, still trying') for _ in range(40)]
            if minute == 993:         # rare 16:33
                msgs.append(('kernel', 'BUG: soft lockup - CPU#3 stuck for 23s! [kworker/3:1:123]'))
            if 1080 <= minute:        # new 18:00-
                msgs += [('kernel', f'XFS (dm-3): metadata I/O error in "xfs_btree_read_buf_block" at daddr 0x{rnd.getrandbits(28):x} len 8 error 5') for _ in range(2)]
        for proc, m in msgs:
            dt = t0 + timedelta(seconds=rnd.uniform(0, 59.999))
            pid = '' if proc == 'kernel' else f'[{rnd.randint(1000, 60000)}]'
            events.append((dt, f'{_short_ts(dt)} {HOST} {proc}{pid}: {m}'))
    events.sort(key=lambda e: e[0])
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        last = DAY + timedelta(days=days) - timedelta(seconds=1)
        f.write(f'-- Logs begin at Mon 2026-10-12 00:00:00 UTC, end at {last.strftime("%a %Y-%m-%d %H:%M:%S")} UTC. --\n')
        for _, line in events:
            f.write(line + '\n')
    return [] if flat else [dict(p) for p in PLANTED]


def planted_sosreport(base, per_minute=60, seed=7, flat=False, name=None, days=1):
    name = name or ('sosreport-node-01-2026-10-12-' + ('flat' if flat else 'anomaly') + (f'-{days}d' if days > 1 else ''))
    root = os.path.join(base, name)
    truth = write_planted_journal(os.path.join(root, 'sos_commands', 'logs', 'journalctl_--no-pager'), per_minute, seed, flat, days)
    stamp = (DAY + timedelta(days=days) - timedelta(seconds=1)).strftime('%a %b %d %H:%M:%S UTC %Y\n')
    with open(os.path.join(root, 'date'), 'w', encoding='utf-8') as f:
        f.write(stamp)
    os.makedirs(os.path.join(root, 'sos_commands', 'date'), exist_ok=True)
    with open(os.path.join(root, 'sos_commands', 'date', 'date'), 'w', encoding='utf-8') as f:
        f.write(stamp)
    with open(os.path.join(root, 'hostname'), 'w', encoding='utf-8') as f:
        f.write(HOST + '\n')
    return root, truth


# ---------------------------------------------------------------- the must-gather

MG_PLANTED = [
    {'kind': 'burst', 'at': '09:00', 'text': 'reconcile failed: conflict', 'source': 'demo-app/api-0/api'},
    {'kind': 'new', 'at': '15:00', 'text': 'x509: certificate has expired', 'source': 'payments-demo/payments-1/gateway'},
]


def _cri(dt, msg, stream='stdout'):
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{dt.microsecond:06d}Z {stream} F {msg}"


def planted_mustgather(base, pods=12, lines_per_pod=4000, seed=11, flat=False, name=None):
    rnd = random.Random(seed)
    name = name or ('must-gather.local.' + ('2222222222' if flat else '1111111111'))
    root = os.path.join(base, name, 'quay-io-example-org-must-gather-sha256-0123456789abcdef')
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(base, name, 'timestamp'), 'w', encoding='utf-8') as f:
        f.write('2026-10-12 00:00:00.000000000 +0000 UTC m=+0.000000001\n2026-10-12 23:59:59.000000000 +0000 UTC m=+86400.000000001\n')
    msgs = [
        (8, lambda: f'I1012 10:00:00.000000 1 controller.go:{rnd.randint(10, 900)}] "Reconciling" object="ns-{rnd.randint(1, 40)}/obj-{rnd.randint(1, 9999)}"'),
        (6, lambda: f'{{"level":"info","ts":"2026-10-12T00:00:00Z","msg":"request served","path":"/healthz","latency_ms":{rnd.randint(1, 80)}}}'),
        (1, lambda: f'W1012 10:00:00.000000 1 reflector.go:{rnd.randint(100, 500)}] watch of *v1.Pod ended with: too old resource version: {rnd.randint(10 ** 6, 10 ** 7)}'),
    ]
    weights = [m[0] for m in msgs]
    spec = [('demo-app', f'api-{i}', 'api') for i in range(pods // 2)] + [('payments-demo', f'payments-{i}', 'gateway') for i in range(pods - pods // 2)]
    truth = [] if flat else [dict(p) for p in MG_PLANTED]
    for ns, pod, container in spec:
        logs = os.path.join(root, 'namespaces', ns, 'pods', pod, container, container, 'logs')
        os.makedirs(logs, exist_ok=True)
        lines = []
        for i in range(lines_per_pod):
            dt = DAY + timedelta(seconds=86400 * i / lines_per_pod + rnd.uniform(0, 86400 / lines_per_pod))
            lines.append((dt, _cri(dt, rnd.choices(msgs, weights=weights)[0][1]())))
        src = f'{ns}/{pod}/{container}'
        if not flat and src == MG_PLANTED[0]['source']:
            for k in range(600):   # 09:00-09:10
                dt = DAY + timedelta(hours=9, seconds=k)
                lines.append((dt, _cri(dt, f'E1012 09:00:00.000000 1 controller.go:211] reconcile failed: conflict on obj-{rnd.randint(1, 50)}', 'stderr')))
        if not flat and src == MG_PLANTED[1]['source']:
            for k in range(0, 9 * 3600, 120):   # 15:00 on, every 2 min
                dt = DAY + timedelta(hours=15, seconds=k)
                lines.append((dt, _cri(dt, f'{{"level":"error","ts":"2026-10-12T15:00:00Z","msg":"tls handshake failed","error":"x509: certificate has expired or is not yet valid: current time 2026-10-12T15:00:00Z is after 2026-10-12T14:59:59Z","peer":"{_ip(rnd)}:443"}}', 'stderr')))
        lines.sort(key=lambda x: x[0])
        with open(os.path.join(logs, 'current.log'), 'w', encoding='utf-8') as f:
            for _, line in lines:
                f.write(line + '\n')
        if not flat and pod == 'api-1':
            with open(os.path.join(logs, 'previous.log'), 'w', encoding='utf-8') as f:
                for k in range(40):
                    dt = DAY + timedelta(hours=3, seconds=k)
                    f.write(_cri(dt, 'panic: runtime error: invalid memory address or nil pointer dereference' if k == 39 else f'I1012 03:00:{k:02d}.000000 1 main.go:42] starting worker {k}') + '\n')
    node_dir = os.path.join(root, 'nodes', 'worker-0.example.test')
    os.makedirs(node_dir, exist_ok=True)
    with open(os.path.join(node_dir, 'worker-0.example.test_logs_journal'), 'w', encoding='utf-8') as f:
        for minute in range(0, 24 * 60, 2):
            dt = DAY + timedelta(minutes=minute, seconds=rnd.randint(0, 59))
            f.write(f"{_short_ts(dt)} worker-0.example.test kubelet[2101]: I1012 {dt.strftime('%H:%M:%S')}.000000 2101 kubelet.go:2400] \"SyncLoop (housekeeping)\"\n")
    return os.path.join(base, name), truth
