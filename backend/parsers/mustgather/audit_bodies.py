"""Request and response bodies of audit events (the WriteRequestBodies and
AllRequestBodies profiles record requestObject / responseObject at level
RequestResponse): masking, flattening, diffs, highlights and the change
records behind the Events explorer's what-changed chips and diffs.

Credential values never leave this module unmasked: Secret data and
stringData values, ConfigMap values under credential-like keys, env
values whose name is credential-like, and any field whose key matches
CREDENTIAL_KEY (token, password, key, cert, ...) are replaced by
"•••• (N bytes)" in every body text, diff and highlight. The unmasked
bodies of the sampled events live only in an in-memory store (bounded)
for the per-event Reveal, which the Flask layer serves on demand; they
are never aggregated, charted, persisted or put in the initial HTML.
"""
import json
import re
from collections import OrderedDict, defaultdict

# a field NAME that holds a credential (a bare "key" is structural: taints, selectors, labels; Secret data is masked by its own rule)
CREDENTIAL_KEY = re.compile(r'(?i)(token|passw|pwd|secret|credential|private|cert|apikey|api[_-]?key|access[_-]?key|[_-]key$|^auth|oauth|ssh)')
NOISY_PATHS = ('apiVersion', 'kind', 'metadata.name', 'metadata.namespace', 'metadata.resourceVersion', 'metadata.managedFields', 'metadata.generation', 'metadata.uid', 'metadata.creationTimestamp', 'metadata.selfLink',
               'metadata.annotations.kubectl.kubernetes.io/last-applied-configuration', 'metadata.annotations.deployment.kubernetes.io/revision', 'status')
SECRET_LIKE_RESOURCES = {'secrets'}
WRITE_VERBS = {'create', 'update', 'patch', 'delete', 'deletecollection'}
BODY_TEXT_MAX = 64 * 1024
MAX_DIFF_PATHS = 200
MAX_STORED_BODY = 256 * 1024
STATE_OBJECTS = 500
BODY_STORE = 1000
VALUE_MAX = 80

MASK = '••••'


def is_credential_key(key):
    return bool(key) and bool(CREDENTIAL_KEY.search(str(key)))


def masked(value):
    try:
        n = len(value) if isinstance(value, (str, bytes)) else len(json.dumps(value))
    except (TypeError, ValueError):
        n = 0
    return f"{MASK} ({n} bytes)"


def mask_body(obj, resource='', _key='', _parent=''):
    """A masked deep copy: Secret data/stringData values, credential-like
    keys anywhere, env values whose name is credential-like."""
    if isinstance(obj, dict):
        kind = str(obj.get('kind') or '')
        secret = resource in SECRET_LIKE_RESOURCES or kind == 'Secret'
        out = {}
        env_name = obj.get('name') if 'value' in obj and 'name' in obj and _parent == 'env' else None
        for k, v in obj.items():
            ks = str(k)
            if secret and _key in ('data', 'stringData'):
                out[ks] = masked(v)
            elif is_credential_key(ks) and not isinstance(v, (dict, list)) and ks not in ('name', 'kind') and not ks.startswith('authorization.k8s.io/'):   # the apiserver's decision / reason annotations are not credentials
                out[ks] = masked(v)
            elif env_name and ks == 'value' and is_credential_key(env_name):
                out[ks] = masked(v)
            else:
                out[ks] = mask_body(v, resource, ks, _key)
        return out
    if isinstance(obj, list):
        return [mask_body(v, resource, _key, _key) for v in obj]
    return obj


def body_text(obj, resource=''):
    """The masked, pretty, truncated JSON of a body: (text, truncated)."""
    try:
        text = json.dumps(mask_body(obj, resource), indent=2, sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        return '', False
    if len(text) > BODY_TEXT_MAX:
        return text[:BODY_TEXT_MAX] + f"\n... truncated ({len(text) - BODY_TEXT_MAX:,} more characters)", True
    return text, False


def _short(value):
    if isinstance(value, (dict, list)):
        try:
            s = json.dumps(value, sort_keys=True)
        except (TypeError, ValueError):
            s = str(value)
    elif value is None:
        s = 'null'
    else:
        s = str(value)
    return s if len(s) <= VALUE_MAX else s[:VALUE_MAX - 1] + '…'


RE_ENV_VALUE_PATH = re.compile(r'\.env\[([^\]]+)\]\.value$')


def sensitive_path(path, secret=False):
    """Is the value at this flattened path a credential? Secret data /
    stringData, a credential-like last key, an env value whose name is
    credential-like."""
    if secret and (path.startswith('data.') or path.startswith('stringData.')):
        return True
    last = path.rsplit('.', 1)[-1]
    last = last.split('[', 1)[0]
    if last not in ('name', 'kind') and is_credential_key(last):
        return True
    m = RE_ENV_VALUE_PATH.search(path)
    return bool(m and is_credential_key(m.group(1)))


def flatten(obj, prefix='', out=None, resource='', depth=0):
    """{path: leaf value} with the RAW values (the comparison needs them);
    list items of dicts with a name key read as [name]; noisy
    metadata/status paths skipped. Display goes through display_value(),
    which masks the sensitive paths."""
    if out is None:
        out = {}
    if len(out) > 4000 or depth > 12:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            if any(path == n or path.startswith(n + '.') or path.startswith(n + '[') for n in NOISY_PATHS):
                continue
            flatten(v, path, out, resource, depth + 1)
        return out
    if isinstance(obj, list):
        for i, v in enumerate(obj):
            label = str(v.get('name')) if isinstance(v, dict) and isinstance(v.get('name'), str) and prefix else str(i)
            flatten(v, f"{prefix}[{label}]", out, resource, depth + 1)
        return out
    out[prefix] = obj
    return out


def display_value(path, value, secret=False):
    """The value as the pages may show it: masked when the path is sensitive."""
    if value is None:
        return None
    return masked(value) if sensitive_path(path, secret) else _short(value)


def diff(old, new, resource=''):
    """[(path, old, new)] between two objects (old may be None); the
    values are compared raw and shown masked where sensitive."""
    secret = resource in SECRET_LIKE_RESOURCES or (isinstance(new, dict) and new.get('kind') == 'Secret') or (isinstance(old, dict) and old.get('kind') == 'Secret')
    a = flatten(old, resource=resource) if old is not None else {}
    b = flatten(new, resource=resource) if new is not None else {}
    changes = []
    for path in sorted(set(a) | set(b)):
        if a.get(path, '\x00') != b.get(path, '\x00'):
            changes.append({'path': path, 'old': display_value(path, a[path], secret) if path in a else None, 'new': display_value(path, b[path], secret) if path in b else None})
            if len(changes) >= MAX_DIFF_PATHS:
                break
    return changes


def patch_paths(patch, old=None, resource=''):
    """A patch body -> (patch type, [(path, old, new)]). A JSON patch is a
    list of ops; a merge / strategic merge patch is an object."""
    secret = resource in SECRET_LIKE_RESOURCES or (isinstance(old, dict) and old.get('kind') == 'Secret')
    if isinstance(patch, list):
        flat_old = flatten(old, resource=resource) if old is not None else {}
        out = []
        for op in patch:
            if not isinstance(op, dict):
                continue
            path = str(op.get('path') or '').strip('/').replace('/', '.')
            path = re.sub(r'\.(\d+)(?=\.|$)', r'[\1]', path)
            value = op.get('value')
            if isinstance(value, dict) or isinstance(value, list):
                for p, v in flatten(value, path, resource=resource).items():
                    out.append({'path': p, 'old': display_value(p, flat_old[p], secret) if p in flat_old else None, 'new': display_value(p, v, secret), 'op': str(op.get('op') or '')})
            else:
                out.append({'path': path, 'old': display_value(path, flat_old[path], secret) if path in flat_old else None, 'new': None if op.get('op') == 'remove' else display_value(path, value, secret), 'op': str(op.get('op') or '')})
            if len(out) >= MAX_DIFF_PATHS:
                break
        return 'JSON patch', out
    if isinstance(patch, dict):
        kind = 'merge patch' if 'apiVersion' not in patch or '$patch' in json.dumps(patch)[:5000] else 'strategic merge patch'
        flat_old = flatten(old, resource=resource) if old is not None else {}
        out = []
        for p, v in flatten(patch, resource=resource).items():
            if p in flat_old and flat_old[p] == v:
                continue
            out.append({'path': p, 'old': display_value(p, flat_old[p], secret) if p in flat_old else None, 'new': display_value(p, v, secret) if v is not None else None, 'op': 'replace' if p in flat_old else ('remove' if v is None else 'add')})
            if len(out) >= MAX_DIFF_PATHS:
                break
        return kind, out
    return '', []


# ---------------------------------------------------------------------------
# Highlights
# ---------------------------------------------------------------------------
RE_IMAGE = re.compile(r'containers\[([^\]]+)\]\.image$')
RE_RESOURCES = re.compile(r'containers\[([^\]]+)\]\.resources\.(requests|limits)\.(\w+)$')
RE_ENV = re.compile(r'containers\[([^\]]+)\]\.env\[([^\]]+)\]\.(name|value|valueFrom.*)$')
RE_LABEL = re.compile(r'^metadata\.(labels|annotations)\.(.+)$')
RE_TAINT = re.compile(r'^spec\.taints\[([^\]]+)\]\.(key|value|effect)$')
RE_RULE = re.compile(r'^rules\[(\d+)\]\.(verbs|resources|apiGroups|resourceNames|nonResourceURLs)\[(\d+)\]$')
RE_SUBJECT = re.compile(r'^subjects\[([^\]]+)\]\.(kind|name|namespace)$')
RE_DATA = re.compile(r'^(data|stringData|binaryData)\.(.+)$')


def highlights(record, diffs, req, resp, old, resource, verb, kind):
    """Human lines derived from the diffs and the objects (never a credential value)."""
    out = []
    seen = set()

    def add(t, text):
        key = (t, text)
        if key not in seen and len(out) < 40:
            seen.add(key)
            out.append({'type': t, 'text': text})
    env_added, env_removed = set(), set()
    for d in diffs:
        p, old_v, new_v = d['path'], d.get('old'), d.get('new')
        m = RE_IMAGE.search(p)
        if m:
            add('image', f"container {m.group(1)}: image {old_v or '(new)'} → {new_v or '(removed)'}")
            continue
        if p == 'spec.replicas' or p.endswith('.replicas') and p.startswith('spec'):
            add('scale', f"replicas {old_v if old_v is not None else '(unset)'} → {new_v if new_v is not None else '(removed)'}")
            continue
        m = RE_RESOURCES.search(p)
        if m:
            add('resources', f"container {m.group(1)}: {m.group(2)}.{m.group(3)} {old_v or '(unset)'} → {new_v or '(removed)'}")
            continue
        m = RE_ENV.search(p)
        if m:
            if m.group(3) == 'name':
                (env_added if new_v else env_removed).add(f"{m.group(1)}: {new_v or old_v}")
            elif m.group(3) == 'value':
                add('env', f"container {m.group(1)}: env {m.group(2)} changed" + ('' if MASK in str(new_v) or MASK in str(old_v) else f" ({old_v if old_v is not None else '(unset)'} → {new_v if new_v is not None else '(removed)'})"))
            continue
        m = RE_LABEL.match(p)
        if m:
            add(m.group(1), f"{m.group(1)[:-1]} {m.group(2)}: {old_v if old_v is not None else '(unset)'} → {new_v if new_v is not None else '(removed)'}")
            continue
        if p == 'spec.unschedulable':
            add('node', 'cordoned' if new_v in ('True', 'true') else 'uncordoned')
            continue
        m = RE_TAINT.match(p)
        if m:
            add('node', f"taint {m.group(1)}: {m.group(2)} {old_v if old_v is not None else '(unset)'} → {new_v if new_v is not None else '(removed)'}")
            continue
        m = RE_DATA.match(p)
        if m:
            key = m.group(2)
            if resource == 'secrets' or kind == 'Secret':
                add('secret', f"key {key} {'added' if old_v is None else 'removed' if new_v is None else 'changed'} (value never shown)")
            else:
                if MASK in str(new_v or '') or MASK in str(old_v or ''):
                    add('configmap', f"key {key} {'added' if old_v is None else 'removed' if new_v is None else 'changed'} (credential-like, value masked)")
                else:
                    add('configmap', f"key {key} {'added' if old_v is None else 'removed' if new_v is None else 'changed'}: {old_v if old_v is not None else '(none)'} → {new_v if new_v is not None else '(removed)'}")
            continue
    if env_added:
        add('env', 'env added: ' + ', '.join(sorted(env_added)))
    if env_removed:
        add('env', 'env removed: ' + ', '.join(sorted(env_removed)))
    # RBAC: rules and subjects, from the objects themselves
    if resource in ('roles', 'clusterroles'):
        for label, rules in (('granted', _rules(req or resp) - _rules(old)), ('revoked', _rules(old) - _rules(req or resp))):
            for r in sorted(rules)[:12]:
                add('rbac', f"rule {label}: {r}")
    if resource in ('rolebindings', 'clusterrolebindings'):
        new_obj = req if isinstance(req, dict) and req.get('kind') not in (None, 'DeleteOptions') else resp
        if verb in ('delete', 'deletecollection'):
            for s in sorted(_subjects(old))[:12]:
                add('rbac', f"binding removed: {s} → {_roleref(old)}")
        else:
            for label, subs in (('bound', _subjects(new_obj) - _subjects(old)), ('unbound', _subjects(old) - _subjects(new_obj))):
                for s in sorted(subs)[:12]:
                    add('rbac', f"{label}: {s} → {_roleref(new_obj or old)}")
            if _roleref(new_obj) and isinstance(old, dict) and _roleref(old) != _roleref(new_obj):
                add('rbac', f"roleRef {_roleref(old)} → {_roleref(new_obj)}")
    if resource in ('customresourcedefinitions', 'validatingwebhookconfigurations', 'mutatingwebhookconfigurations', 'securitycontextconstraints', 'apiservices') and verb != 'delete':
        paths = [d['path'] for d in diffs if not d['path'].startswith('metadata')][:6]
        add('cluster', f"{kind or resource} {verb}: " + (', '.join(paths) if paths else 'no field-level difference recorded'))
    if verb in ('delete', 'deletecollection') and isinstance(req, dict) and req.get('kind') == 'DeleteOptions':
        opts = [f"{k}={req[k]}" for k in ('propagationPolicy', 'gracePeriodSeconds', 'orphanDependents', 'dryRun') if k in req]
        record['delete_options'] = ', '.join(opts)
        # a routine Background delete is plain; an explicit policy or grace period is worth keeping
        record['delete_telling'] = req.get('propagationPolicy') not in (None, 'Background') or 'gracePeriodSeconds' in req or 'orphanDependents' in req
        if opts:
            add('delete', 'deleteOptions: ' + ', '.join(opts))
    return out


def _rules(obj):
    out = set()
    if not isinstance(obj, dict):
        return out
    for rule in obj.get('rules') or []:
        if not isinstance(rule, dict):
            continue
        verbs = ','.join(sorted(str(v) for v in rule.get('verbs') or []))
        groups = ','.join(sorted(str(v) or 'core' for v in rule.get('apiGroups') or [])) or 'core'
        resources = ','.join(sorted(str(v) for v in rule.get('resources') or [])) or ','.join(sorted(str(v) for v in rule.get('nonResourceURLs') or []))
        out.add(f"{verbs} on {groups}/{resources}")
    return out


def _subjects(obj):
    out = set()
    if not isinstance(obj, dict):
        return out
    for s in obj.get('subjects') or []:
        if isinstance(s, dict):
            out.add(f"{s.get('kind', '')}:{s.get('name', '')}" + (f" ({s['namespace']})" if s.get('namespace') else ''))
    return out


def _roleref(obj):
    if not isinstance(obj, dict) or not isinstance(obj.get('roleRef'), dict):
        return ''
    r = obj['roleRef']
    return f"{r.get('kind', '')}/{r.get('name', '')}"


# ---------------------------------------------------------------------------
# The change tracker: per-object previous state, the change records, the
# bounded unmasked body store for Reveal
# ---------------------------------------------------------------------------
PLAIN_TYPES = {'labels', 'annotations', 'delete'}   # routine: labels, annotations, a delete's options
CHANGE_TYPES = ('image', 'scale', 'resources', 'env', 'labels', 'annotations', 'rbac', 'configmap', 'secret', 'node', 'cluster', 'delete')
BAD_TYPES = {'rbac', 'secret', 'delete', 'cluster'}
WARN_TYPES = {'node', 'configmap', 'env', 'resources', 'image', 'scale'}


class BodyStore:
    """The unmasked request / response bodies of events a page may Reveal,
    keyed by auditID, bounded, in memory only (never in a response's
    initial payload)."""

    def __init__(self, size=BODY_STORE):
        self.size = size
        self.store = OrderedDict()

    def keep(self, audit_id, req, resp):
        if not audit_id or (req is None and resp is None):
            return
        self.store[audit_id] = {'request': req, 'response': resp}
        self.store.move_to_end(audit_id)
        while len(self.store) > self.size:
            self.store.popitem(last=False)

    def body(self, audit_id, part):
        entry = self.store.get(audit_id)
        if not entry or entry.get(part) is None:
            return None
        try:
            return json.dumps(entry[part], indent=2, sort_keys=True, ensure_ascii=False)
        except (TypeError, ValueError):
            return None


def object_key(summary, resource, resp):
    """(namespace, resource, name) of the object a write touched."""
    ns, name = summary['namespace'], summary['name']
    if not name and isinstance(resp, dict):
        name = str((resp.get('metadata') or {}).get('name') or '')
    return (ns, resource, name)


def remember_state(state, key, obj, limit=STATE_OBJECTS):
    """Keep the object's latest known state (bounded OrderedDict)."""
    if not isinstance(obj, dict) or obj.get('kind') in (None, 'Status', 'DeleteOptions'):
        return
    try:
        if len(json.dumps(obj)) > MAX_STORED_BODY:
            return
    except (TypeError, ValueError):
        return
    state[key] = obj
    state.move_to_end(key)
    while len(state) > limit:
        state.popitem(last=False)


def next_state(state, key, ev, verb, sub, old):
    """Advance the per-object state after a write: a delete forgets it, a
    scale keeps the object with the new replicas, else the response (or the
    request) is the new state."""
    req = ev.get('requestObject') if isinstance(ev.get('requestObject'), dict) else None
    resp = ev.get('responseObject') if isinstance(ev.get('responseObject'), dict) else None
    if verb in ('delete', 'deletecollection'):
        state.pop(key, None)
    elif sub == 'scale' and isinstance(old, dict):
        new_obj = resp if isinstance(resp, dict) else req
        replicas = ((new_obj or {}).get('spec') or {}).get('replicas') if isinstance(new_obj, dict) else None
        updated = json.loads(json.dumps(old))
        updated.setdefault('spec', {})['replicas'] = replicas
        remember_state(state, key, updated)
    elif isinstance(resp, dict):
        remember_state(state, key, resp)
    elif isinstance(req, dict) and verb in ('create', 'update'):
        remember_state(state, key, req)


def build_record(summary, ev, resource, verb, old, kind_hint=''):
    """The change record of a write event that carries a body: the field
    diffs (old from `old`, the object's earlier state, or from the patch
    itself; just the new value when unknown), the highlights, the chips, the
    types and a severity. Pure: the caller keeps the state."""
    req = ev.get('requestObject') if isinstance(ev.get('requestObject'), (dict, list)) else None
    resp = ev.get('responseObject') if isinstance(ev.get('responseObject'), dict) else None
    if req is None and resp is None:
        return None
    ns, _res, name = object_key(summary, resource, resp)
    kind = (resp or {}).get('kind') if isinstance(resp, dict) else None
    if kind in ('Status', 'DeleteOptions', 'Scale'):
        kind = None
    if not kind and isinstance(req, dict) and req.get('kind') not in (None, 'DeleteOptions', 'Scale', 'Status'):
        kind = req.get('kind')
    if not kind and isinstance(old, dict) and old.get('kind'):
        kind = old.get('kind')
    kind = kind or kind_hint or (resource[:-1].capitalize() if resource.endswith('s') else resource.capitalize())
    sub = summary.get('subresource') or ''
    patch_type = ''
    if verb == 'patch':
        patch_type, diffs = patch_paths(req, old, resource)
    elif verb in ('create', 'update'):
        new_obj = req if isinstance(req, dict) and req.get('kind') not in ('DeleteOptions',) else resp
        if sub == 'scale' and isinstance(new_obj, dict) and isinstance(old, dict):
            diffs = diff({'spec': {'replicas': (old.get('spec') or {}).get('replicas')}}, {'spec': {'replicas': (new_obj.get('spec') or {}).get('replicas')}}, resource)
        else:
            diffs = diff(old, new_obj, resource)
    else:
        diffs = []
    record = {
        'id': str(ev.get('auditID') or ''), 'ts': summary['ts'], 'ts_sort': summary['ts_sort'], 'user': summary['user'], 'impersonated': summary['impersonated'],
        'verb': verb, 'subresource': sub, 'kind': str(kind), 'resource': summary['resource'], 'namespace': ns, 'name': name, 'key': f"{ns + '/' if ns else ''}{kind}/{name}",
        'code': summary['code'], 'patch_type': patch_type, 'diffs': diffs, 'paths': [d['path'] for d in diffs], 'old_known': old is not None, 'delete_options': '',
        'highlights': [],
    }
    record['highlights'] = highlights(record, diffs, req, resp, old, resource, verb, record['kind'])
    types = []
    for h in record['highlights']:
        if h['type'] not in types:
            types.append(h['type'])
    record['types'] = types
    record['chips'] = chips(record)
    record['severity'] = 'bad' if BAD_TYPES & set(types) else 'warn' if WARN_TYPES & set(types) else 'info'
    record['telling'] = any(t not in PLAIN_TYPES for t in types) or record.get('delete_telling', False)
    return record


def chips(r):
    """Compact "what changed" chips for a change record, one per highlight
    type: 'image -> 1.5.0', 'replicas 3 -> 5', '+rule get,list core/secrets',
    '3 configmap keys', 'cordoned' ... (never a credential value)."""
    out = []
    by_type = defaultdict(list)
    for h in r['highlights']:
        by_type[h['type']].append(h['text'])
    for t, texts in by_type.items():
        if t == 'image':
            tags = [x.split('\u2192')[-1].strip().rsplit(':', 1)[-1] for x in texts if '\u2192' in x]
            out.append('image \u2192 ' + ', '.join(tags[:2]) if tags else 'image')
        elif t == 'scale':
            out.append(texts[0])
        elif t == 'rbac':
            first = texts[0]
            if first.startswith('rule granted'):
                out.append('+rule ' + first.split(': ', 1)[1])
            elif first.startswith('rule revoked'):
                out.append('-rule ' + first.split(': ', 1)[1])
            elif first.startswith('binding removed'):
                out.append('binding removed')
            else:
                out.append(first.split(' \u2192 ')[0])
            if len(texts) > 1:
                out[-1] += f" (+{len(texts) - 1})"
        elif t in ('configmap', 'secret'):
            out.append(f"{len(texts)} {'secret' if t == 'secret' else 'configmap'} key{'s' if len(texts) != 1 else ''}")
        elif t == 'node':
            out.append('cordoned' if 'cordoned' in texts else 'uncordoned' if 'uncordoned' in texts else 'taint')
        elif t == 'cluster':
            out.append(texts[0].split(':', 1)[0])
        elif t == 'delete':
            out.append(texts[0].replace('deleteOptions: ', ''))
        elif t == 'resources':
            out.append(texts[0].split(': ', 1)[-1] if ': ' in texts[0] else 'resources')
        elif t == 'env':
            added = sum(1 for x in texts if x.startswith('env added'))
            removed = sum(1 for x in texts if x.startswith('env removed'))
            out.append('env ' + ' '.join(filter(None, [f"+{added}" if added else '', f"-{removed}" if removed else '', 'changed' if not added and not removed else ''])))
        elif t == 'labels':
            out.append(f"{len(texts)} label{'s' if len(texts) != 1 else ''}")
        elif t == 'annotations':
            out.append(f"{len(texts)} annotation{'s' if len(texts) != 1 else ''}")
    if not out:
        out.append(f"{len(r['diffs'])} field{'s' if len(r['diffs']) != 1 else ''}" if r['diffs'] else r['verb'])
    return out
