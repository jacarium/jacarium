"""The data behind a must-gather detail page (the Pod, Node, Deployment ... views the templates open from a list):
the object's own Findings, its status badge, the structured sections (containers, conditions, volumes, scheduling,
the object's recent events, the container logs the gather holds, who last wrote which fields) - everything the page
shows before the raw YAML. The parsers attach it as `_detail` on each object they return; the templates render it
through the shared diagDetail component (backend/static/diagnostics-ui.js).

    pod_detail(pod, events, directory, gather)          -> the Pod's detail
    node_detail(node, directory, gather)                -> the Node's (capacity / allocatable meters, pods on it)
    deployment_detail(dep, events, replicasets, gather) -> the Deployment's (replicas, strategy, its ReplicaSets)
    generic_detail(obj, events, gather)                 -> any other kind: conditions, events, field ownership

Pure functions over the parsed manifests (dicts), so a test can plant a CrashLoopBackOff pod and read the result;
only pod_logs() and pods_by_node() touch the gather directory, and only to list files.
"""
import os
import re

from parsers.findings import finding, sort_findings
from parsers.mustgather import managed_fields
from parsers.mustgather._common import resolve_data_dir

CRASH = ('CrashLoopBackOff', 'Error', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError')
PULL = ('ImagePullBackOff', 'ErrImagePull', 'InvalidImageName')
SETUP = ('ContainerCreating', 'PodInitializing')
EVENTS_MAX = 20
PODS_PER_NODE_MAX = 400
PHASE_BADGE = {'Running': 'ok', 'Succeeded': 'muted', 'Completed': 'muted', 'Pending': 'warn', 'Failed': 'bad', 'Unknown': 'bad'}
SECRETISH = managed_fields.re.compile(r'(password|passwd|secret|token|credential|private|cert|cookie|auth|api[-_]?key|access[-_]?key)', re.I)


# ---------------------------------------------------------------- quantities and times

def quantity(value):
    """A Kubernetes quantity as a number: cpu '500m' -> 0.5 (cores), memory '16Gi' -> bytes, '122000000Ki' -> bytes,
    '3' -> 3.0; None when unreadable."""
    if value is None:
        return None
    s = str(value).strip()
    m = re.match(r'^([0-9.]+)([a-zA-Z]*)$', s)
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    unit = m.group(2)
    scale = {'': 1, 'm': 0.001, 'k': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12, 'P': 1e15, 'E': 1e18,
             'Ki': 1024, 'Mi': 1024 ** 2, 'Gi': 1024 ** 3, 'Ti': 1024 ** 4, 'Pi': 1024 ** 5, 'Ei': 1024 ** 6}
    if unit not in scale:
        return None
    return n * scale[unit]


def human_bytes(n):
    if n is None:
        return ''
    n = float(n)
    for unit in ('B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'):
        if n < 1024 or unit == 'PiB':
            return (f'{n:.0f} {unit}' if unit == 'B' or n >= 100 else f'{n:.1f} {unit}')
        n /= 1024
    return ''


def human_cpu(cores):
    if cores is None:
        return ''
    if cores < 1:
        return f'{int(round(cores * 1000))}m'
    return f'{cores:g}'


def human_quantity(resource, raw):
    """The quantity as the page shows it: cpu in cores or millicores, memory and storage in binary units, the rest as is."""
    v = quantity(raw)
    if v is None:
        return str(raw) if raw is not None else ''
    if resource == 'cpu':
        return human_cpu(v)
    if resource in ('memory', 'ephemeral-storage', 'storage') or resource.startswith('hugepages'):
        return human_bytes(v)
    return f'{v:g}'


def seconds_before(iso, gather):
    """Seconds from a timestamp to the gather time; None when either is unknown."""
    t = managed_fields._parse_time(iso)
    g = managed_fields._parse_time(gather) if not hasattr(gather, 'timestamp') else gather
    if not t or not g:
        return None
    return int((g - t).total_seconds())


def relative(iso, gather):
    s = seconds_before(iso, gather)
    return managed_fields.relative(s) if s is not None else ''


def duration(seconds):
    """'4 min', '2 h 10 min', '3 d 2 h' for an age."""
    if seconds is None or seconds < 0:
        return ''
    seconds = int(seconds)
    if seconds < 60:
        return f'{seconds} s'
    minutes = seconds // 60
    if minutes < 60:
        return f'{minutes} min'
    hours, minutes = divmod(minutes, 60)
    if hours < 48:
        return f'{hours} h' + (f' {minutes} min' if minutes else '')
    days, hours = divmod(hours, 24)
    return f'{days} d' + (f' {hours} h' if hours else '')


# ---------------------------------------------------------------- the events of one object, the logs of a pod

def object_events(events, kind, name, gather=None, limit=EVENTS_MAX):
    """The events whose involvedObject is this kind / name, the newest first, at most `limit` of them."""
    out = []
    for e in events or []:
        if not isinstance(e, dict) or e.get('kind') == 'Error':
            continue
        obj = e.get('involvedObject') or {}
        if obj.get('kind') != kind or obj.get('name') != name:
            continue
        last = e.get('lastTimestamp') or e.get('eventTime') or (e.get('metadata') or {}).get('creationTimestamp') or ''
        out.append({
            'type': e.get('type') or 'Normal', 'reason': e.get('reason') or '', 'message': str(e.get('message') or '')[:600],
            'count': int(e.get('count') or 1), 'last': str(last), 'first': str(e.get('firstTimestamp') or last),
            'component': ((e.get('source') or {}).get('component') or e.get('reportingComponent') or ''),
            'relative': relative(last, gather) if gather else '',
        })
    out.sort(key=lambda x: x['last'], reverse=True)
    return out[:limit]


def pod_logs(directory, namespace, pod):
    """The container log files the gather holds for a pod (namespaces/<ns>/pods/<pod>/<container>/<container>/logs/
    <current|previous|previous.insecure>.log) with their sizes, the current log of each container first."""
    out = []
    directory = resolve_data_dir(directory)   # the data directory (an image-named subdirectory, when there is one)
    base = os.path.join(directory, 'namespaces', namespace, 'pods', pod)
    if not os.path.isdir(base):
        return out
    for container in sorted(os.listdir(base)):
        logs = os.path.join(base, container, container, 'logs')
        if not os.path.isdir(logs):
            continue
        for fn in sorted(os.listdir(logs)):
            if not fn.endswith('.log'):
                continue
            p = os.path.join(logs, fn)
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            out.append({'container': container, 'file': fn, 'kind': fn[:-4], 'path': os.path.relpath(p, directory), 'bytes': size, 'size': human_bytes(size), 'empty': size == 0})
    order = {'current': 0, 'previous': 1}
    out.sort(key=lambda x: (x['container'], order.get(x['kind'], 2), x['file']))
    return out


# ---------------------------------------------------------------- pods

def _state_of(state):
    """A container state ({'running': {...}} / {'waiting': {...}} / {'terminated': {...}}) as one record."""
    state = state or {}
    for kind in ('running', 'waiting', 'terminated'):
        if kind in state and isinstance(state[kind], dict):
            s = state[kind]
            return {'kind': kind, 'reason': s.get('reason') or '', 'message': str(s.get('message') or '')[:400],
                    'started_at': s.get('startedAt') or '', 'finished_at': s.get('finishedAt') or '',
                    'exit_code': s.get('exitCode') if s.get('exitCode') is not None else None, 'signal': s.get('signal')}
    return None


def _probe(p):
    """'HTTP GET :8080/healthz every 10 s, 3 failures' for a probe spec."""
    if not isinstance(p, dict):
        return ''
    how = ''
    if p.get('httpGet'):
        h = p['httpGet']
        how = f"HTTP {h.get('scheme') or 'GET'} :{h.get('port')}{h.get('path') or '/'}"
    elif p.get('tcpSocket'):
        how = f"TCP :{p['tcpSocket'].get('port')}"
    elif p.get('exec'):
        cmd = p['exec'].get('command') or []
        how = 'exec ' + ' '.join(str(c) for c in cmd)[:80]
    elif p.get('grpc'):
        how = f"gRPC :{p['grpc'].get('port')}"
    parts = [how] if how else []
    if p.get('periodSeconds'):
        parts.append(f"every {p['periodSeconds']} s")
    if p.get('initialDelaySeconds'):
        parts.append(f"after {p['initialDelaySeconds']} s")
    if p.get('timeoutSeconds'):
        parts.append(f"timeout {p['timeoutSeconds']} s")
    if p.get('failureThreshold'):
        parts.append(f"{p['failureThreshold']} failures")
    return ', '.join(parts)


def _env(e):
    """One env entry: its name, where the value comes from, and the literal value when it is not secret-ish."""
    name = str(e.get('name') or '')
    vf = e.get('valueFrom') or {}
    if vf.get('secretKeyRef'):
        r = vf['secretKeyRef']
        return {'name': name, 'from': f"secret {r.get('name')}/{r.get('key')}", 'value': None, 'masked': False}
    if vf.get('configMapKeyRef'):
        r = vf['configMapKeyRef']
        return {'name': name, 'from': f"configmap {r.get('name')}/{r.get('key')}", 'value': None, 'masked': False}
    if vf.get('fieldRef'):
        return {'name': name, 'from': f"field {vf['fieldRef'].get('fieldPath')}", 'value': None, 'masked': False}
    if vf.get('resourceFieldRef'):
        return {'name': name, 'from': f"resource {vf['resourceFieldRef'].get('resource')}", 'value': None, 'masked': False}
    value = e.get('value')
    if value is None:
        return {'name': name, 'from': '', 'value': '', 'masked': False}
    if SECRETISH.search(name):
        return {'name': name, 'from': '', 'value': str(value), 'masked': True}
    return {'name': name, 'from': '', 'value': str(value)[:200], 'masked': False}


def container_cards(pod):
    """One record per container (the init containers first, flagged): image, state and last state with the reason
    and exit code, restarts, ready, resources, ports, probes, mounts, env names (secret-ish values masked)."""
    spec = pod.get('spec') or {}
    status = pod.get('status') or {}
    by_name = {}
    for c in (status.get('containerStatuses') or []) + (status.get('initContainerStatuses') or []):
        if isinstance(c, dict) and c.get('name'):
            by_name[c['name']] = c
    out = []
    for init, group in ((True, spec.get('initContainers') or []), (False, spec.get('containers') or [])):
        for c in group:
            if not isinstance(c, dict):
                continue
            st = by_name.get(c.get('name'), {})
            res = c.get('resources') or {}
            card = {
                'name': c.get('name') or '?', 'init': init, 'image': c.get('image') or '', 'image_id': st.get('imageID') or '',
                'state': _state_of(st.get('state')), 'last_state': _state_of(st.get('lastState')),
                'restarts': int(st.get('restartCount') or 0), 'ready': bool(st.get('ready')), 'started': bool(st.get('started')),
                'sidecar': bool(init and c.get('restartPolicy') == 'Always'),
                'requests': {k: human_quantity(k, v) for k, v in (res.get('requests') or {}).items()},
                'limits': {k: human_quantity(k, v) for k, v in (res.get('limits') or {}).items()},
                'ports': [f"{p.get('containerPort')}/{p.get('protocol') or 'TCP'}" + (f" ({p['name']})" if p.get('name') else '') for p in c.get('ports') or [] if isinstance(p, dict)],
                'probes': {k: _probe(c.get(k + 'Probe')) for k in ('liveness', 'readiness', 'startup') if c.get(k + 'Probe')},
                'mounts': [f"{m.get('mountPath')} ({m.get('name')}{', ro' if m.get('readOnly') else ''})" for m in c.get('volumeMounts') or [] if isinstance(m, dict)],
                'env': [_env(e) for e in c.get('env') or [] if isinstance(e, dict)],
                'env_from': [f"{'secret' if s.get('secretRef') else 'configmap'} {(s.get('secretRef') or s.get('configMapRef') or {}).get('name')}" for s in c.get('envFrom') or [] if isinstance(s, dict)],
                'pull_policy': c.get('imagePullPolicy') or '',
                'command': ' '.join(str(x) for x in (c.get('command') or []))[:300], 'args': ' '.join(str(x) for x in (c.get('args') or []))[:300],
            }
            out.append(card)
    return out


def conditions_of(obj):
    """The status.conditions as rows: type, status, reason, message, the transition time."""
    out = []
    for c in (obj.get('status') or {}).get('conditions') or []:
        if not isinstance(c, dict):
            continue
        out.append({'type': c.get('type') or '', 'status': str(c.get('status') or ''), 'reason': c.get('reason') or '',
                    'message': str(c.get('message') or '')[:400], 'since': c.get('lastTransitionTime') or '',
                    'updated': c.get('lastUpdateTime') or c.get('lastHeartbeatTime') or c.get('lastProbeTime') or ''})
    return out


def pod_volumes(pod):
    out = []
    for v in (pod.get('spec') or {}).get('volumes') or []:
        if not isinstance(v, dict):
            continue
        kind, source = '', ''
        for k in ('persistentVolumeClaim', 'secret', 'configMap', 'emptyDir', 'projected', 'hostPath', 'downwardAPI', 'csi', 'nfs', 'ephemeral', 'image'):
            if k in v:
                kind = k
                s = v[k] if isinstance(v[k], dict) else {}
                source = s.get('claimName') or s.get('secretName') or s.get('name') or s.get('path') or s.get('driver') or ''
                if k == 'emptyDir':
                    source = ('memory' if s.get('medium') == 'Memory' else 'disk') + (f", {s['sizeLimit']}" if s.get('sizeLimit') else '')
                if k == 'projected':
                    source = ', '.join(sorted({list(src.keys())[0] for src in s.get('sources') or [] if isinstance(src, dict) and src}))
                break
        if not kind:
            kind = next((k for k in v if k != 'name'), '')
        out.append({'name': v.get('name') or '', 'kind': kind, 'source': str(source)[:160]})
    return out


def pod_scheduling(pod):
    spec = pod.get('spec') or {}
    tol = []
    for t in spec.get('tolerations') or []:
        if not isinstance(t, dict):
            continue
        s = t.get('key') or '*'
        if t.get('operator') == 'Exists':
            s += ' exists'
        elif t.get('value') is not None:
            s += '=' + str(t.get('value'))
        if t.get('effect'):
            s += ':' + str(t['effect'])
        if t.get('tolerationSeconds') is not None:
            s += f" for {t['tolerationSeconds']} s"
        tol.append(s)
    affinity = spec.get('affinity') or {}
    return {
        'node_selector': {str(k): str(v) for k, v in (spec.get('nodeSelector') or {}).items()},
        'tolerations': tol,
        'affinity': sorted(k for k in affinity if affinity.get(k)),
        'topology_spread': len(spec.get('topologySpreadConstraints') or []),
        'priority_class': spec.get('priorityClassName') or '', 'priority': spec.get('priority'),
        'scheduler': spec.get('schedulerName') or '', 'runtime_class': spec.get('runtimeClassName') or '',
        'service_account': spec.get('serviceAccountName') or spec.get('serviceAccount') or '',
        'host_network': bool(spec.get('hostNetwork')), 'dns_policy': spec.get('dnsPolicy') or '', 'restart_policy': spec.get('restartPolicy') or '',
        'termination_grace': spec.get('terminationGracePeriodSeconds'),
    }


def readiness(pod):
    """READY and STATUS as kubectl prints them (printers.go podStatus). READY counts the regular containers and the
    native sidecars (an init container with restartPolicy Always): ready ones / all of them - an init container that
    ran and finished is not one of them, and a status the spec has no container for is not counted either. STATUS is
    the phase, or what the first unfinished init container is doing (Init:i/n, Init:<reason>, Init:ExitCode:n), or the
    last container's waiting / terminated reason, Completed for a pod that ran to the end, Terminating when it is
    being deleted. {ready, total, text, status, initializing, init: {total, done, sidecars}}"""
    spec = pod.get('spec') or {}
    status = pod.get('status') or {}
    meta = pod.get('metadata') or {}
    regular = [c.get('name') for c in spec.get('containers') or [] if isinstance(c, dict)]
    inits = [c for c in spec.get('initContainers') or [] if isinstance(c, dict)]
    sidecars = [c.get('name') for c in inits if c.get('restartPolicy') == 'Always']
    by = {c.get('name'): c for c in status.get('containerStatuses') or [] if isinstance(c, dict)}
    iby = {c.get('name'): c for c in status.get('initContainerStatuses') or [] if isinstance(c, dict)}
    total = len(regular) + len(sidecars)
    ready = sum(1 for n in regular if (by.get(n) or {}).get('ready')) + sum(1 for n in sidecars if (iby.get(n) or {}).get('ready'))
    reason = status.get('reason') or status.get('phase') or 'Unknown'
    initializing = False
    done = 0
    for i, c in enumerate(inits):
        st = iby.get(c.get('name')) or {}
        s = st.get('state') or {}
        term, wait = s.get('terminated') or {}, s.get('waiting') or {}
        if term and term.get('exitCode') == 0:
            done += 1
            continue
        if c.get('restartPolicy') == 'Always' and st.get('started'):
            done += 1
            continue
        if term:
            reason = f"Init:{term['reason']}" if term.get('reason') else (f"Init:Signal:{term['signal']}" if term.get('signal') else f"Init:ExitCode:{term.get('exitCode')}")
        elif wait.get('reason') and wait['reason'] != 'PodInitializing':
            reason = f"Init:{wait['reason']}"
        else:
            reason = f"Init:{i}/{len(inits)}"
        initializing = True
        break
    if not initializing:
        has_running = False
        for n in reversed(regular):
            st = by.get(n) or {}
            s = st.get('state') or {}
            wait, term = s.get('waiting') or {}, s.get('terminated') or {}
            if wait.get('reason'):
                reason = wait['reason']
            elif term:
                reason = term.get('reason') or (f"Signal:{term['signal']}" if term.get('signal') else f"ExitCode:{term.get('exitCode')}")
            elif st.get('ready') and s.get('running'):
                has_running = True
        if reason == 'Completed' and has_running:
            reason = 'Running' if any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in status.get('conditions') or [] if isinstance(c, dict)) else 'NotReady'
    if meta.get('deletionTimestamp'):
        reason = 'Unknown' if status.get('reason') == 'NodeLost' else 'Terminating'
    if reason == 'Succeeded':
        reason = 'Completed'
    return {'ready': ready, 'total': total, 'text': f"{ready}/{total}", 'status': reason, 'initializing': initializing,
            'init': {'total': len(inits), 'done': done, 'sidecars': sidecars}}


def pod_state(pod):
    """('phase or waiting reason', restarts, [OOMKilled containers]) - the same reading as pod.py's."""
    status = pod.get('status') or {}
    phase = status.get('phase') or '?'
    restarts, oom, waiting = 0, [], ''
    for c in (status.get('containerStatuses') or []) + (status.get('initContainerStatuses') or []):
        restarts += int(c.get('restartCount') or 0)
        w = (c.get('state') or {}).get('waiting') or {}
        if w.get('reason') and w.get('reason') not in SETUP:
            waiting = w['reason']
        for st in ((c.get('state') or {}).get('terminated'), (c.get('lastState') or {}).get('terminated')):
            if st and st.get('reason') == 'OOMKilled':
                oom.append(c.get('name') or '?')
    return (waiting or phase), restarts, sorted(set(oom))


def pod_badge(pod):
    """The status badge of the header: the waiting reason or the phase, coloured by how bad it is."""
    state, restarts, oom = pod_state(pod)
    status = pod.get('status') or {}
    phase = status.get('phase') or '?'
    r = readiness(pod)
    if r['status'].startswith('Init:'):
        # an init container that fails is the pod's problem (kubectl's Init:CrashLoopBackOff); one still running is a wait
        bare = r['status'][5:]
        return {'kind': 'bad' if bare in CRASH or bare in PULL or bare.startswith('ExitCode') or bare.startswith('Signal') else 'warn', 'text': r['status']}
    if state in CRASH or state in PULL or phase in ('Failed', 'Unknown'):
        return {'kind': 'bad', 'text': state}
    if phase == 'Pending' or state in SETUP:
        return {'kind': 'warn', 'text': state}
    if r['status'] == 'Terminating':
        return {'kind': 'muted', 'text': 'Terminating'}
    if phase == 'Succeeded':
        return {'kind': 'muted', 'text': 'Completed'}
    if phase == 'Running':
        if r['total'] and r['ready'] < r['total']:
            return {'kind': 'warn', 'text': f"Running, {r['text']} ready"}
        return {'kind': 'ok', 'text': 'Running'}
    return {'kind': PHASE_BADGE.get(phase, 'muted'), 'text': state}


def pod_findings(pod, events, ownership, gather, namespace=''):
    """The pod's own Findings: a container failing to start (bad), OOMKilled or a crash with its exit code (bad /
    warn), image pull errors (bad), restarts (warn from five), a Pending pod with the scheduling events' reason
    (warn), conditions not True (warn), failed probes from the events (warn), a recent human edit (info); a GOOD
    line when nothing is wrong."""
    out = []
    name = (pod.get('metadata') or {}).get('name') or '?'
    status = pod.get('status') or {}
    spec = pod.get('spec') or {}
    phase = status.get('phase') or '?'
    link = {'tab': 'system', 'sub_tab': 'events', 'query': name}
    by_reason = {}
    for e in events or []:
        by_reason.setdefault(e['reason'], []).append(e)
    statuses = [c for c in (status.get('containerStatuses') or []) + (status.get('initContainerStatuses') or []) if isinstance(c, dict)]
    for c in statuses:
        cname = c.get('name') or '?'
        w = (c.get('state') or {}).get('waiting') or {}
        reason = w.get('reason') or ''
        if reason in CRASH:
            last = (c.get('lastState') or {}).get('terminated') or {}
            why = f"exit code {last.get('exitCode')}" + (f" ({last['reason']})" if last.get('reason') else '') if last.get('exitCode') is not None else ''
            when = relative(last.get('finishedAt'), gather) if last.get('finishedAt') else ''
            out.append(finding('bad', f"{cname} is in {reason}", (w.get('message') or '')[:160] + ('; ' if w.get('message') else '') + ('last run: ' + why + (', ' + when if when else '') + '; ' if why else '') + 'its previous log says why', count=3, **link))
        elif reason in PULL:
            out.append(finding('bad', f"{cname}: {reason}", (w.get('message') or 'the image cannot be pulled: the name, the tag or the registry credentials')[:200], count=3, **link))
        elif reason and reason not in SETUP:
            out.append(finding('warn', f"{cname} is waiting: {reason}", (w.get('message') or '')[:200], **link))
        for st_kind, st in (('state', (c.get('state') or {}).get('terminated')), ('lastState', (c.get('lastState') or {}).get('terminated'))):
            if not st:
                continue
            when = relative(st.get('finishedAt'), gather) if st.get('finishedAt') else ''
            if st.get('reason') == 'OOMKilled':
                limit = ((spec_container(spec, cname).get('resources') or {}).get('limits') or {}).get('memory')
                out.append(finding('bad', f"{cname} was OOMKilled" + (' ' + when if when else ''), f"exit code {st.get('exitCode')}; the container hit its memory limit" + (f" of {limit}" if limit else '') + ' and was killed: raise the limit or find the leak', count=2, **link))
            elif st_kind == 'lastState' and st.get('exitCode') not in (None, 0) and reason not in CRASH:
                out.append(finding('warn', f"{cname} exited with code {st.get('exitCode')}" + (f" ({st['reason']})" if st.get('reason') else '') + (' ' + when if when else ''), (st.get('message') or 'the previous log holds its last lines')[:200], **link))
        restarts = int(c.get('restartCount') or 0)
        if restarts >= 5:
            out.append(finding('warn', f"{cname} restarted {restarts} times", 'a container that keeps dying: its last state and the events above say why', count=restarts))
        elif restarts:
            out.append(finding('info', f"{cname} restarted {restarts} time{'s' if restarts != 1 else ''}", 'the last state names the reason', count=restarts))
    if phase == 'Pending':
        sched = by_reason.get('FailedScheduling') or []
        why = sched[0]['message'][:240] if sched else ''
        age = pod.get('_age_seconds')
        out.append(finding('warn', 'Pending' + (f" for {duration(age)}" if age else ''), why or 'no node fits, a volume is missing, or the images are still being pulled: the events say which', count=2, **link))
    if phase == 'Failed':
        out.append(finding('warn', f"The pod Failed" + (f": {status.get('reason')}" if status.get('reason') else ''), (status.get('message') or 'an evicted pod, or a job that failed')[:200], **link))
    if phase not in ('Succeeded', 'Failed'):
        for c in conditions_of(pod):
            if c['status'] == 'True' or c['type'] in ('DisruptionTarget',):
                continue
            if c['type'] == 'PodScheduled':
                out.append(finding('bad', 'Not scheduled', (c['message'] or c['reason'] or 'no node took the pod')[:240], **link))
            elif c['type'] in ('Ready', 'ContainersReady', 'Initialized', 'PodReadyToStartContainers'):
                if c['type'] == 'ContainersReady' and any(x['type'] == 'Ready' and x['status'] != 'True' for x in conditions_of(pod)):
                    continue
                out.append(finding('warn', f"{c['type']} is {c['status'] or 'not True'}" + (f": {c['reason']}" if c['reason'] else ''), (c['message'] or '')[:200] + (f" (since {managed_fields._parse_time(c['since']).strftime('%Y-%m-%d %H:%M:%S')})" if managed_fields._parse_time(c['since']) else '')))
    for reason, sev in (('Unhealthy', 'warn'), ('FailedMount', 'warn'), ('FailedAttachVolume', 'warn'), ('FailedCreatePodSandBox', 'warn'), ('NetworkNotReady', 'warn'), ('Evicted', 'warn')):
        for e in (by_reason.get(reason) or [])[:2]:
            out.append(finding(sev, f"{reason}" + (f" x{e['count']}" if e['count'] > 1 else '') + (' ' + e['relative'] if e['relative'] else ''), e['message'][:240], count=e['count'], **link))
    edit = managed_fields.finding_for(ownership or [], 'the pod')
    if edit:
        out.append(edit)
    r = readiness(pod)
    if r['initializing'] and not any(f['severity'] == 'bad' for f in out):
        # an init container not yet through: the pod waits for it (a failing one is a bad line above already)
        out.append(finding('warn', r['status'], f"init container {r['init']['done'] + 1} of {r['init']['total']} has not finished: the pod stays Pending until every init container exits with code 0", **link))
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        if phase == 'Succeeded':
            out.append(finding('good', 'Completed', 'every container exited with code 0'))
        elif phase == 'Running':
            out.append(finding('good', f"Running, {r['text']} containers ready", 'no restart, no failed probe, every condition True'))
    return sort_findings(out)


def spec_container(spec, name):
    for c in (spec.get('containers') or []) + (spec.get('initContainers') or []):
        if isinstance(c, dict) and c.get('name') == name:
            return c
    return {}


def owner_of(obj):
    """The controller owner reference as 'Kind name' and its kind / name, or None."""
    for o in (obj.get('metadata') or {}).get('ownerReferences') or []:
        if isinstance(o, dict) and o.get('name'):
            return {'kind': o.get('kind') or '', 'name': o.get('name'), 'controller': bool(o.get('controller'))}
    return None


def ownership_of(obj, gather):
    """The managedFields entries, capped for the page (the newest twelve, thirty paths each)."""
    entries = managed_fields.entries(obj, gather)
    out = []
    for e in entries[:12]:
        e = dict(e)
        e['fields'] = e['fields'][:30]
        out.append(e)
    return {'entries': out, 'total': len(entries), 'latest_human': managed_fields.summary(entries)}


def pod_detail(pod, events, directory, gather):
    """Everything the Pod detail page shows before the YAML."""
    meta = pod.get('metadata') or {}
    spec = pod.get('spec') or {}
    status = pod.get('status') or {}
    name, ns = meta.get('name') or '?', meta.get('namespace') or ''
    evs = object_events(events, 'Pod', name, gather)
    own = ownership_of(pod, gather)
    sched = pod_scheduling(pod)
    owner = owner_of(pod)
    state, restarts, oom = pod_state(pod)
    return {
        'kind': 'Pod',
        'badge': pod_badge(pod),
        'findings': pod_findings(pod, evs, own['entries'], gather, ns),
        'summary': {
            'namespace': ns, 'node': spec.get('nodeName') or '', 'phase': status.get('phase') or '', 'state': state,
            'qos': status.get('qosClass') or '', 'ip': status.get('podIP') or '', 'host_ip': status.get('hostIP') or '',
            'ips': [x.get('ip') for x in status.get('podIPs') or [] if isinstance(x, dict) and x.get('ip')],
            'age': duration(pod.get('_age_seconds')), 'created': meta.get('creationTimestamp') or '', 'started': status.get('startTime') or '',
            'owner': owner, 'service_account': sched['service_account'], 'priority_class': sched['priority_class'],
            'restarts': restarts, 'ready': readiness(pod)['text'], 'status': readiness(pod)['status'], 'init': readiness(pod)['init'],
            'labels': {str(k): str(v) for k, v in (meta.get('labels') or {}).items()},
            'annotations': len(meta.get('annotations') or {}),
            'uid': meta.get('uid') or '',
        },
        'containers': container_cards(pod),
        'conditions': conditions_of(pod),
        'volumes': pod_volumes(pod),
        'scheduling': sched,
        'events': evs,
        'logs': pod_logs(directory, ns, name) if directory else [],
        'ownership': own,
    }


# ---------------------------------------------------------------- nodes

NODE_RESOURCES = ('cpu', 'memory', 'pods', 'ephemeral-storage')


def node_meters(node):
    """capacity vs allocatable per resource (cpu, memory, pods, ephemeral storage, hugepages when set): the
    allocatable share of the capacity, both as the page shows them."""
    status = node.get('status') or {}
    cap, alloc = status.get('capacity') or {}, status.get('allocatable') or {}
    names = [r for r in NODE_RESOURCES if r in cap or r in alloc]
    names += sorted(r for r in cap if r.startswith('hugepages') and quantity(cap.get(r)))
    out = []
    for r in names:
        c, a = quantity(cap.get(r)), quantity(alloc.get(r))
        out.append({'resource': r, 'capacity': human_quantity(r, cap.get(r)) if cap.get(r) is not None else '', 'allocatable': human_quantity(r, alloc.get(r)) if alloc.get(r) is not None else '',
                    'capacity_raw': c, 'allocatable_raw': a, 'share': (round(100.0 * a / c, 1) if c and a is not None else None)})
    return out


def node_taints(node):
    out = []
    for t in (node.get('spec') or {}).get('taints') or []:
        if isinstance(t, dict):
            out.append(f"{t.get('key')}" + (f"={t['value']}" if t.get('value') is not None else '') + f":{t.get('effect') or ''}")
    return out


def _cond(obj, kind):
    for c in (obj.get('status') or {}).get('conditions') or []:
        if isinstance(c, dict) and c.get('type') == kind:
            return c
    return {}


_pods_by_node_cache = {}


def pods_by_node(directory):
    """{node: [{'namespace', 'name', 'phase'}, ...]} from every pod manifest's text (no YAML parse: the nodeName and
    the phase lines), cached per gather directory."""
    directory = resolve_data_dir(directory)
    key = os.path.abspath(directory)
    if key in _pods_by_node_cache:
        return _pods_by_node_cache[key]
    out = {}
    base = os.path.join(directory, 'namespaces')
    if os.path.isdir(base):
        for ns in sorted(os.listdir(base)):
            pods_dir = os.path.join(base, ns, 'pods')
            if not os.path.isdir(pods_dir):
                continue
            for pod in sorted(os.listdir(pods_dir)):
                p = os.path.join(pods_dir, pod, pod + '.yaml')
                try:
                    with open(p, 'r', encoding='utf-8', errors='replace') as f:
                        text = f.read(400000)
                except OSError:
                    continue
                m = re.search(r'^\s*nodeName:\s*(\S+)', text, re.M)
                if not m:
                    continue
                ph = re.search(r'^\s*phase:\s*(\S+)', text, re.M)
                out.setdefault(m.group(1).strip('"\''), []).append({'namespace': ns, 'name': pod, 'phase': ph.group(1).strip('"\'') if ph else ''})
    _pods_by_node_cache[key] = out
    return out


def node_findings(node, pods, ownership, gather):
    out = []
    name = (node.get('metadata') or {}).get('name') or '?'
    ready = _cond(node, 'Ready')
    link = {'tab': 'workloads', 'sub_tab': 'pod', 'query': name}
    if ready.get('status') != 'True':
        unknown = ready.get('status') != 'False'
        out.append(finding('bad', 'NotReady' + (' (the kubelet stopped reporting)' if unknown else ''), (ready.get('message') or ready.get('reason') or '')[:200] + (f" (since {ready.get('lastTransitionTime')})" if ready.get('lastTransitionTime') else ''), **link))
    for kind in ('MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'):
        c = _cond(node, kind)
        if c.get('status') == 'True':
            out.append(finding('warn', kind, (c.get('message') or c.get('reason') or '')[:200]))
    if (node.get('spec') or {}).get('unschedulable'):
        out.append(finding('warn', 'Cordoned', 'unschedulable: no new pod lands on it'))
    taints = node_taints(node)
    if taints and not all(t.startswith('node-role.kubernetes.io/') for t in taints):
        out.append(finding('info', f"{len(taints)} taint{'s' if len(taints) != 1 else ''}", ', '.join(taints)[:200]))
    cap = next((m for m in node_meters(node) if m['resource'] == 'pods'), None)
    if cap and cap['allocatable_raw'] and pods:
        share = 100.0 * len(pods) / cap['allocatable_raw']
        if share >= 80:
            out.append(finding('bad' if share >= 95 else 'warn', f"{len(pods)} of {int(cap['allocatable_raw'])} pods ({share:.0f}% of the limit)", 'the kubelet refuses new pods at the limit (max-pods)', count=int(share), **link))
    failing = [p for p in pods if p['phase'] in ('Failed', 'Unknown')]
    if failing:
        out.append(finding('warn', f"{len(failing)} pod{'s' if len(failing) != 1 else ''} Failed or Unknown on this node", ', '.join(p['namespace'] + '/' + p['name'] for p in failing[:4]) + (' …' if len(failing) > 4 else ''), count=len(failing), **link))
    edit = managed_fields.finding_for(ownership or [], 'the node')
    if edit:
        out.append(edit)
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', 'Ready, no pressure', f"{len(pods)} pods" if pods else 'no pod listed on it'))
    return sort_findings(out)


def node_detail(node, directory, gather):
    meta = node.get('metadata') or {}
    status = node.get('status') or {}
    info = status.get('nodeInfo') or {}
    name = meta.get('name') or '?'
    labels = meta.get('labels') or {}
    roles = sorted(k.split('/', 1)[1] for k in labels if k.startswith('node-role.kubernetes.io/') and k.split('/', 1)[1])
    pods = pods_by_node(directory).get(name, []) if directory else []
    own = ownership_of(node, gather)
    ready = _cond(node, 'Ready')
    cordoned = bool((node.get('spec') or {}).get('unschedulable'))
    badge = {'kind': 'ok', 'text': 'Ready'} if ready.get('status') == 'True' else {'kind': 'bad', 'text': 'NotReady' if ready.get('status') == 'False' else 'Unknown'}
    if cordoned and badge['kind'] == 'ok':
        badge = {'kind': 'warn', 'text': 'Ready, cordoned'}
    phases = {}
    for p in pods:
        phases[p['phase'] or '?'] = phases.get(p['phase'] or '?', 0) + 1
    return {
        'kind': 'Node',
        'badge': badge,
        'findings': node_findings(node, pods, own['entries'], gather),
        'summary': {
            'roles': roles or ['worker'], 'created': meta.get('creationTimestamp') or '', 'age': duration(seconds_before(meta.get('creationTimestamp'), gather)),
            'addresses': [{'type': a.get('type'), 'address': a.get('address')} for a in status.get('addresses') or [] if isinstance(a, dict)],
            'kubelet': info.get('kubeletVersion') or '', 'runtime': info.get('containerRuntimeVersion') or '', 'os': info.get('osImage') or '',
            'kernel': info.get('kernelVersion') or '', 'arch': info.get('architecture') or '', 'machine_id': info.get('machineID') or '',
            'provider_id': (node.get('spec') or {}).get('providerID') or '', 'pod_cidr': (node.get('spec') or {}).get('podCIDR') or '',
            'cordoned': cordoned, 'labels': {str(k): str(v) for k, v in labels.items()}, 'annotations': len(meta.get('annotations') or {}),
            'machine': (meta.get('annotations') or {}).get('machine.openshift.io/machine') or '',
            'current_config': (meta.get('annotations') or {}).get('machineconfiguration.openshift.io/currentConfig') or '',
            'desired_config': (meta.get('annotations') or {}).get('machineconfiguration.openshift.io/desiredConfig') or '',
            'mc_state': (meta.get('annotations') or {}).get('machineconfiguration.openshift.io/state') or '',
        },
        'meters': node_meters(node),
        'conditions': conditions_of(node),
        'taints': node_taints(node),
        'pods': {'count': len(pods), 'phases': phases, 'rows': pods[:PODS_PER_NODE_MAX]},
        'images': len(status.get('images') or []),
        'volumes_in_use': len(status.get('volumesInUse') or []),
        'ownership': own,
    }


# ---------------------------------------------------------------- deployments

def replicasets_for(dep, replicasets, gather):
    """The ReplicaSets this Deployment owns (by ownerReferences uid or name), the newest revision first."""
    meta = dep.get('metadata') or {}
    uid, name = meta.get('uid'), meta.get('name')
    out = []
    for rs in replicasets or []:
        if not isinstance(rs, dict):
            continue
        owners = (rs.get('metadata') or {}).get('ownerReferences') or []
        mine = any(isinstance(o, dict) and o.get('kind') == 'Deployment' and ((uid and o.get('uid') == uid) or o.get('name') == name) for o in owners)
        if not mine:
            continue
        m, st, sp = rs.get('metadata') or {}, rs.get('status') or {}, rs.get('spec') or {}
        ann = m.get('annotations') or {}
        out.append({'name': m.get('name') or '?', 'revision': ann.get('deployment.kubernetes.io/revision') or '', 'replicas': int(sp.get('replicas') or 0),
                    'ready': int(st.get('readyReplicas') or 0), 'available': int(st.get('availableReplicas') or 0), 'created': m.get('creationTimestamp') or '',
                    'age': duration(seconds_before(m.get('creationTimestamp'), gather)), 'hash': (m.get('labels') or {}).get('pod-template-hash') or ''})
    out.sort(key=lambda r: (-(int(r['revision']) if str(r['revision']).isdigit() else -1), r['name']))
    return out


def deployment_findings(dep, replicasets, events, ownership):
    out = []
    spec, status = dep.get('spec') or {}, dep.get('status') or {}
    name = (dep.get('metadata') or {}).get('name') or '?'
    link = {'tab': 'workloads', 'sub_tab': 'pod', 'query': name}
    want = int(spec.get('replicas') if spec.get('replicas') is not None else 1)
    avail = int(status.get('availableReplicas') or 0)
    if want and avail == 0:
        out.append(finding('bad', f"0 of {want} replicas available", 'the deployment serves nothing: its pods say why', count=want, **link))
    elif want and avail < want:
        out.append(finding('warn', f"{avail} of {want} replicas available", f"{int(status.get('unavailableReplicas') or (want - avail))} unavailable", count=want - avail, **link))
    if spec.get('paused'):
        out.append(finding('warn', 'Paused', 'no rollout happens while paused'))
    for c in conditions_of(dep):
        if c['type'] == 'Progressing' and c['status'] == 'False':
            out.append(finding('warn', 'The rollout is not progressing' + (f": {c['reason']}" if c['reason'] else ''), c['message'][:200]))
        if c['type'] == 'ReplicaFailure' and c['status'] == 'True':
            out.append(finding('bad', 'ReplicaFailure' + (f": {c['reason']}" if c['reason'] else ''), c['message'][:200]))
    updated = int(status.get('updatedReplicas') or 0)
    if want and updated < want and not any(f['title'].startswith('The rollout') for f in out):
        out.append(finding('info', f"Rolling out: {updated} of {want} replicas updated", 'the new ReplicaSet is still scaling up'))
    live = [r for r in replicasets if r['replicas']]
    if len(live) > 1:
        out.append(finding('info', f"{len(live)} ReplicaSets with pods", ', '.join(f"{r['name']} ({r['ready']}/{r['replicas']})" for r in live[:3]), count=len(live)))
    edit = managed_fields.finding_for(ownership or [], 'the deployment')
    if edit:
        out.append(edit)
    if not any(f['severity'] in ('bad', 'warn') for f in out):
        out.append(finding('good', f"{avail} of {want} replicas available", 'every condition True'))
    return sort_findings(out)


def deployment_detail(dep, events, replicasets, gather):
    meta, spec, status = dep.get('metadata') or {}, dep.get('spec') or {}, dep.get('status') or {}
    name, ns = meta.get('name') or '?', meta.get('namespace') or ''
    own = ownership_of(dep, gather)
    rs = replicasets_for(dep, replicasets, gather)
    evs = object_events(events, 'Deployment', name, gather)
    want = int(spec.get('replicas') if spec.get('replicas') is not None else 1)
    avail = int(status.get('availableReplicas') or 0)
    strategy = spec.get('strategy') or {}
    ru = strategy.get('rollingUpdate') or {}
    badge = {'kind': 'ok', 'text': f'{avail}/{want} available'} if want and avail >= want else ({'kind': 'bad', 'text': f'0/{want} available'} if want and avail == 0 else {'kind': 'warn', 'text': f'{avail}/{want} available'})
    if spec.get('paused'):
        badge = {'kind': 'warn', 'text': 'Paused'}
    template = (spec.get('template') or {})
    return {
        'kind': 'Deployment',
        'badge': badge,
        'findings': deployment_findings(dep, rs, evs, own['entries']),
        'summary': {
            'namespace': ns, 'replicas': want, 'updated': int(status.get('updatedReplicas') or 0), 'ready': int(status.get('readyReplicas') or 0),
            'available': avail, 'unavailable': int(status.get('unavailableReplicas') or 0), 'strategy': strategy.get('type') or '',
            'max_surge': ru.get('maxSurge'), 'max_unavailable': ru.get('maxUnavailable'), 'min_ready': spec.get('minReadySeconds'),
            'progress_deadline': spec.get('progressDeadlineSeconds'), 'revision_history': spec.get('revisionHistoryLimit'), 'paused': bool(spec.get('paused')),
            'revision': (meta.get('annotations') or {}).get('deployment.kubernetes.io/revision') or '', 'generation': meta.get('generation'), 'observed': status.get('observedGeneration'),
            'selector': {str(k): str(v) for k, v in ((spec.get('selector') or {}).get('matchLabels') or {}).items()},
            'age': duration(dep.get('_age_seconds')) or duration(seconds_before(meta.get('creationTimestamp'), gather)), 'created': meta.get('creationTimestamp') or '',
            'labels': {str(k): str(v) for k, v in (meta.get('labels') or {}).items()}, 'annotations': len(meta.get('annotations') or {}),
        },
        'containers': container_cards({'spec': template.get('spec') or {}, 'status': {}}),
        'conditions': conditions_of(dep),
        'replicasets': rs,
        'events': evs,
        'ownership': own,
    }


# ---------------------------------------------------------------- any other kind

def generic_findings(obj, ownership, what):
    out = []
    for c in conditions_of(obj):
        bad_true = c['type'] in ('Degraded', 'ReplicaFailure', 'Failed') and c['status'] == 'True'
        bad_false = c['type'] in ('Available', 'Ready', 'Approved', 'Updated', 'DisruptionAllowed') and c['status'] == 'False'
        if bad_true or bad_false:
            out.append(finding('warn', f"{c['type']} is {c['status']}" + (f": {c['reason']}" if c['reason'] else ''), c['message'][:200]))
    edit = managed_fields.finding_for(ownership or [], what)
    if edit:
        out.append(edit)
    return sort_findings(out)


def generic_detail(obj, events, gather, what='the object'):
    meta = obj.get('metadata') or {}
    own = ownership_of(obj, gather)
    kind = obj.get('kind') or ''
    template = (obj.get('spec') or {}).get('template') if isinstance(obj.get('spec'), dict) else None
    return {
        'kind': kind,
        'findings': generic_findings(obj, own['entries'], what),
        # a workload's pod template as container cards (a DaemonSet, StatefulSet, ReplicaSet ...)
        'containers': container_cards({'spec': template.get('spec') or {}, 'status': {}}) if isinstance(template, dict) else [],
        'conditions': conditions_of(obj),
        'events': object_events(events, kind, meta.get('name') or '', gather) if kind else [],
        'ownership': own,
        'age': duration(seconds_before(meta.get('creationTimestamp'), gather)),
        'owner': owner_of(obj),
        'labels': {str(k): str(v) for k, v in (meta.get('labels') or {}).items()},
        'annotations': len(meta.get('annotations') or {}),
    }


# ---------------------------------------------------------------- a namespace's lists, read once

_list_cache = {}


def namespace_list(directory, namespace, group, filename):
    """The items of a namespaced list file (namespaces/<ns>/<group>/<file>, a *List or one object), cached per file
    and mtime; [] when missing or unreadable."""
    from parsers.mustgather._common import safe_load
    p = os.path.join(resolve_data_dir(directory), 'namespaces', namespace, group, filename)
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        return []
    key = (os.path.abspath(p), mtime)
    if key in _list_cache:
        return _list_cache[key]
    items = []
    try:
        with open(p, 'r', encoding='utf-8', errors='replace') as f:
            doc = safe_load(f)
        if isinstance(doc, dict) and isinstance(doc.get('items'), list):
            items = [e for e in doc['items'] if isinstance(e, dict)]
        elif isinstance(doc, dict) and doc.get('kind'):
            items = [doc]
    except Exception:  # noqa: BLE001 - an unreadable list leaves the section empty, never the page
        items = []
    if len(_list_cache) > 64:
        _list_cache.clear()
    _list_cache[key] = items
    return items


def namespace_events(directory, namespace):
    """The events.yaml of a namespace as a list (cached per file and mtime); [] when missing or unreadable."""
    return namespace_list(directory, namespace, 'core', 'events.yaml')
