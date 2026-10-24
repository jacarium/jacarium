"""The OpenShift audit policy profile (Default / WriteRequestBodies /
AllRequestBodies / None) of a must-gather: read from the APIServer
config when it is in the gather (cluster-scoped-resources/
config.openshift.io/apiservers/cluster.yaml: spec.audit.profile and
spec.audit.customRules), else inferred from the events: writes at
RequestResponse while reads stay at Metadata -> WriteRequestBodies,
reads at RequestResponse too -> AllRequestBodies, everything at Metadata
-> Default, no events -> None. OpenShift logs Secrets, Routes, OAuth
tokens and clients at Metadata in every profile, so those resources are
excluded from the inference (the scan keeps the counters apart).

Also the note the pages show: what the profile records, what the pages
can and cannot show because of it, the per-apiserver and per-window
differences, a config-vs-events mismatch, and how to change the profile.
"""
import os

try:
    import yaml
except ImportError:  # pragma: no cover - PyYAML is a backend dependency
    yaml = None

PROFILES = ('Default', 'WriteRequestBodies', 'AllRequestBodies', 'None')
EXCLUDED_RESOURCES = {'secrets', 'routes', 'oauthclients', 'oauthaccesstokens', 'oauthauthorizetokens', 'useroauthaccesstokens', 'tokenreviews',
                      'subjectaccessreviews', 'selfsubjectaccessreviews', 'selfsubjectrulesreviews', 'localsubjectaccessreviews', 'oauth/authorize', 'oauth/token'}
DESCRIBES = {
    'Default': 'metadata only: who / what / when and the status, no request or response bodies; the Events explorer cannot show what was changed.',
    'WriteRequestBodies': 'request and response bodies of writes (create, update, patch, delete), reads at metadata; the Events explorer shows what was changed.',
    'AllRequestBodies': 'request and response bodies of reads and writes (the largest logs); the Events explorer shows what was changed and reads carry bodies too.',
    'None': 'auditing disabled: no events are recorded.',
}
COMMANDS = {
    'WriteRequestBodies': "oc patch apiserver cluster --type=merge -p '{\"spec\":{\"audit\":{\"profile\":\"WriteRequestBodies\"}}}'",
    'AllRequestBodies': "oc patch apiserver cluster --type=merge -p '{\"spec\":{\"audit\":{\"profile\":\"AllRequestBodies\"}}}'",
    'Default': "oc patch apiserver cluster --type=merge -p '{\"spec\":{\"audit\":{\"profile\":\"Default\"}}}'",
}
CUSTOM_RULES_COMMAND = "oc patch apiserver cluster --type=merge -p '{\"spec\":{\"audit\":{\"customRules\":[{\"group\":\"system:authenticated:oauth\",\"profile\":\"WriteRequestBodies\"}]}}}'"
VERIFY_COMMAND = "oc get apiserver cluster -o jsonpath='{.spec.audit}'"
GATHER_COMMAND = "oc adm must-gather -- /usr/bin/gather_audit_logs"
CAVEAT = ("The change rolls out the kube-apiserver, openshift-apiserver and oauth-apiserver pods (a few minutes; watch with `oc get co kube-apiserver`); "
          "bodies increase the audit log volume and the apiservers' CPU and memory; it applies to new events only, so collect a fresh must-gather afterwards.")


def read_config(root):
    """(profile, custom_rules, path) from the APIServer config, or ('', [], '')."""
    candidates = [os.path.join(root, 'cluster-scoped-resources', 'config.openshift.io', 'apiservers', 'cluster.yaml'),
                  os.path.join(root, 'cluster-scoped-resources', 'config.openshift.io', 'apiservers.yaml')]
    for path in candidates:
        if not os.path.isfile(path) or yaml is None:
            continue
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                doc = yaml.safe_load(f.read(512 * 1024))
        except Exception:
            continue
        if isinstance(doc, dict) and doc.get('kind') == 'APIServerList':
            items = doc.get('items') or []
            doc = next((i for i in items if isinstance(i, dict) and (i.get('metadata') or {}).get('name') == 'cluster'), items[0] if items else None)
        if not isinstance(doc, dict):
            continue
        audit = (doc.get('spec') or {}).get('audit') if isinstance(doc.get('spec'), dict) else None
        audit = audit if isinstance(audit, dict) else {}
        profile = str(audit.get('profile') or 'Default')  # the API defaults to Default when unset
        rules = [{'group': str(r.get('group') or ''), 'profile': str(r.get('profile') or '')} for r in (audit.get('customRules') or []) if isinstance(r, dict)]
        return profile, rules, os.path.relpath(path, root)
    return '', [], ''


def infer(counts):
    """counts = {'write': n, 'write_bodies': n, 'read': n, 'read_bodies': n}
    (non-sensitive resources only) -> (profile, evidence text)."""
    w, wb, r, rb = counts.get('write', 0), counts.get('write_bodies', 0), counts.get('read', 0), counts.get('read_bodies', 0)
    if not w and not r:
        return 'None', 'no audit events'
    wp = 100.0 * wb / w if w else 0.0
    rp = 100.0 * rb / r if r else 0.0
    evidence = f"RequestResponse on {wp:.0f}% of non-sensitive write events, {rp:.0f}% of reads"
    if rp >= 50:
        return 'AllRequestBodies', evidence
    if wp >= 50:
        return 'WriteRequestBodies', evidence
    if wb or rb:
        return 'Default (partly)', evidence + ' (a partial record: custom rules, or a profile change during the capture)'
    return 'Default', evidence


def _pct_word(counts):
    w, wb = counts.get('write', 0), counts.get('write_bodies', 0)
    return f"{100.0 * wb / w:.0f}%" if w else 'n/a'


def describe(root, overall, per_apiserver, windows):
    """The profile note: the authoritative profile from the config, the
    inferred one with its evidence, the differences, the mismatch."""
    cfg_profile, rules, cfg_path = read_config(root)
    inferred, evidence = infer(overall)
    profile = cfg_profile or inferred
    source = 'APIServer config' if cfg_profile else 'inferred from the events'
    base = inferred.split(' ')[0]
    mismatch = bool(cfg_profile) and cfg_profile in PROFILES and base in PROFILES and cfg_profile != base and not (cfg_profile == 'Default' and inferred.startswith('Default')) and overall.get('write', 0) + overall.get('read', 0) > 0
    per_api = []
    inferred_by_api = {}
    for name, c in sorted(per_apiserver.items()):
        p, e = infer(c)
        if c.get('write'):
            inferred_by_api[name] = p
        per_api.append({'name': name, 'profile': p, 'evidence': e, 'write_pct': _pct_word(c)})
    differs_by_api = len(set(inferred_by_api.values())) > 1   # among the apiservers that saw writes
    win = []
    for label, c in windows:
        p, e = infer(c)
        win.append({'label': label, 'profile': p, 'evidence': e})
    differs_by_window = len({w['profile'].split(' ')[0] for w in win if w['profile'] != 'None'}) > 1
    active = cfg_profile or base
    commands = [{'profile': p, 'command': COMMANDS[p]} for p in (['WriteRequestBodies', 'AllRequestBodies', 'Default'] if active in ('Default', 'None', '') else ['Default', 'WriteRequestBodies', 'AllRequestBodies']) if p != active]
    return {
        'profile': profile, 'source': source, 'config_profile': cfg_profile, 'config_path': cfg_path, 'custom_rules': rules,
        'inferred': inferred, 'evidence': evidence, 'describe': DESCRIBES.get(profile.split(' ')[0], DESCRIBES['Default']),
        'mismatch': mismatch, 'per_apiserver': per_api, 'differs_by_apiserver': differs_by_api, 'windows': win, 'differs_by_window': differs_by_window,
        'bodies': bool(overall.get('write_bodies') or overall.get('read_bodies')),
        'commands': commands, 'custom_rules_command': CUSTOM_RULES_COMMAND, 'verify_command': VERIFY_COMMAND, 'gather_command': GATHER_COMMAND, 'caveat': CAVEAT,
        'excluded': sorted(EXCLUDED_RESOURCES),
    }
