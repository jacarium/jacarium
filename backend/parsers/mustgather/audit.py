"""Audit: the one page over the API audit logs, an explorer of every event
(tabs/mustgather_audit.html; the rows come from parsers/mustgather/
audit_search.py behind /audit_events_search). From the one cached scan
(parsers/mustgather/audit_logs.py) the page takes what it needs before
the first search answers: the time range (the quick ranges), the
vocabulary of the filter bar, whether request bodies are recorded (the
body filters are disabled otherwise) and the whole capture's timeline,
status codes and verbs, which the visuals draw until a filter is set.
"""
from parsers.mustgather import audit_bodies, audit_logs, audit_search


def parse(directory):
    a = audit_logs.scan(directory)
    page = {
        'available': a['available'], 'reason': a['reason'], 'root': a['root'], 'image_dir': a['image_dir'],
        'totals': a['totals'], 'time': a['time'], 'timeline': a['timeline'], 'profile': a['profile'], 'bodies_total': a['bodies_total'],
        'bodies': bool((a.get('profile') or {}).get('bodies')),
        'verbs': [v['name'] for v in a['verbs']], 'apiservers': [s['name'] for s in a['apiservers']], 'nodes': [n['name'] for n in a['nodes']],
        'users': [u['name'] for u in a['users']], 'resources': [r['name'] for r in a['resources']], 'namespaces': [n['name'] for n in a['namespaces']],
        'agents': [g['name'] for g in a['agents']],
        # the whole capture's status codes and verbs, in the shape the search answers them (the page's bars until a filter is set)
        'scan': {
            'codes': [{'name': str(c['code']), 'count': c['count']} for c in a['codes']],
            'verbs': [{'name': v['name'], 'count': v['count'], 'errors': v['errors']} for v in a['verbs']],
        },
        'change_types': list(audit_bodies.CHANGE_TYPES),
        'limit': audit_search.LIMIT_DEFAULT, 'limit_max': audit_search.LIMIT_MAX, 'budget_seconds': audit_search.BUDGET_SECONDS,
    }
    return {'audit': page, 'findings': findings_for(page)}


def findings_for(page):
    """The Findings strip of the Audit explorer: what the capture holds (events, the span, the apiservers), the
    error share (warn over 5%), the bodies available; no audit log (info)."""
    from parsers.findings import finding, no_data, sort_findings
    if not page.get('available'):
        return [no_data('No audit log in this must-gather', ['audit_logs/kube-apiserver/*', 'audit_logs/openshift-apiserver/*', 'audit_logs/oauth-apiserver/*'], page.get('reason') or 'collected without --image-stream=openshift/must-gather -- /usr/bin/gather_audit_logs')]
    out = []
    totals = page.get('totals') or {}
    codes = (page.get('scan') or {}).get('codes') or []
    total = sum(c['count'] for c in codes) or totals.get('events') or 0
    errors = sum(c['count'] for c in codes if str(c['name'])[:1] in ('4', '5'))
    if total and errors / total >= 0.05:
        out.append(finding('warn', f"{100.0 * errors / total:.1f}% of the requests answered 4xx / 5xx ({errors:,} of {total:,})".replace(',', '\u202f'), 'the status bars show which codes; a filter on the code lists the events', count=int(100.0 * errors / total)))
    t = page.get('time') or {}
    out.append(finding('info', f"{total:,} audit events".replace(',', '\u202f') + (f" from {t.get('first') or t.get('start')} to {t.get('last') or t.get('end')}" if (t.get('first') or t.get('start')) else ''), f"{len(page.get('apiservers') or [])} apiserver{'s' if len(page.get('apiservers') or []) != 1 else ''}, {len(page.get('users') or [])} users, {len(page.get('namespaces') or [])} namespaces" + ('; request and response bodies available' if page.get('bodies') else '')))
    return sort_findings(out)
