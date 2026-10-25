"""A must-gather without audit_logs/ (collected without the audit-logs gather image):

  - the Audit tab is still listed by /get_tabs - every registered tab of both report types is, whatever the
    gather holds (the Findings strip explains what is missing; no tab hides for missing data; the allow-list
    below is for tabs hidden on purpose, empty today);
  - /load_tab for Audit renders the Findings strip alone: one INFO in the shared no-data wording ("No audit logs
    in this must-gather - looked for audit_logs/ (...); trimmed gather"), no content panel, no controls, no chart,
    no table, no "audit-only" wording;
  - /audit_events_search answers cleanly (200, no events, no error) for such a gather.

Self-contained, no test framework: run with the backend venv interpreter.
  backend/venv/bin/python -I tests/mustgather_audit_absent.test.py
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')

TMP = tempfile.mkdtemp(prefix='jacarium-audit-absent-')
HOME = os.path.join(TMP, 'home')
REPORTS = os.path.join(TMP, 'reports')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_REPORTS_ROOT'] = REPORTS
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
os.environ.pop('JACARIUM_ENV_FILE', None)
os.environ.pop('JACARIUM_AUTH_MODE', None)

# the mock reports (tests/fixtures/diagnostics-mock), then the must-gather's audit_logs/ removed
gen = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'fixtures', 'diagnostics-mock', 'generate.py'), '--out', REPORTS, '--no-archives'],
                     capture_output=True, text=True)
if gen.returncode != 0:
    print('FAIL - the mock generator failed:', gen.stderr[-800:])
    sys.exit(1)
MG = os.path.join(REPORTS, 'must-gather.local.1234567890')
SOS = os.path.join(REPORTS, 'sosreport-web-01-2026-10-13-abcdef')
OLD_SOS = os.path.join(REPORTS, 'sosreport-old-01-2026-10-01-oldfmt')
for base, dirs, _files in os.walk(MG):
    for d in list(dirs):
        if d == 'audit_logs':
            shutil.rmtree(os.path.join(base, d))
            dirs.remove(d)

sys.path.insert(0, BACKEND)
os.chdir(BACKEND)
from flask import Flask  # noqa: E402
import log_viewer  # noqa: E402

# tabs hidden on purpose for a report that lacks their data: none today (every plugin is always listed)
HIDDEN_ON_PURPOSE = {'sosreport': set(), 'mustgather': set()}

results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


# the blueprint on a bare app (the packaged app's request gate wants the Electron token; the routes are the same)
flask_app = Flask(__name__, template_folder=os.path.join(BACKEND, 'templates'))
flask_app.register_blueprint(log_viewer.log_viewer)
flask_app.secret_key = 'mg-audit-absent-test'
client = flask_app.test_client()


def post(path, payload):
    return client.post(path, json=payload)


def registered(report_type):
    out = set()
    for tab, info in log_viewer.PARSERS[report_type].items():
        out.add(tab)
        for sub in (info.get('sub_tabs') or {}):
            out.add(tab + '/' + sub)
    return out


def listed(answer):
    out = set()
    for t in answer.get('tabs') or []:
        out.add(t['tab_name'])
        for s in t.get('sub_tabs') or []:
            out.add(t['tab_name'] + '/' + s['tab_name'])
    return out


# ---- every registered tab is listed, for a trimmed gather and for a sosreport without data ----
for report_type, directory, what in (('mustgather', MG, 'a must-gather without audit_logs/'), ('sosreport', OLD_SOS, 'the old-format sosreport (no data)'), ('sosreport', SOS, 'the mock sosreport')):
    r = post('/get_tabs', {'report_type': report_type, 'directory': directory})
    got = listed(r.get_json() or {}) if r.status_code == 200 else set()
    want = registered(report_type) - HIDDEN_ON_PURPOSE[report_type]
    missing = sorted(want - got)
    check(f"/get_tabs lists every registered {report_type} tab for {what} ({len(want)} tabs and sub-tabs)", r.status_code == 200 and not missing, f"status {r.status_code}, missing {missing[:8]}")
check("the Audit tab is in the must-gather list without audit_logs/", 'audit' in listed(post('/get_tabs', {'report_type': 'mustgather', 'directory': MG}).get_json() or {}))

# ---- the Audit page: the Findings strip alone, in the shared wording ----
r = post('/load_tab', {'report_type': 'mustgather', 'tab': 'audit', 'directory': MG})
html = ((r.get_json() or {}).get('html') or '') if r.status_code == 200 else ''
text = re.sub(r'<[^>]+>', ' ', html)
text = re.sub(r'\s+', ' ', text)
findings = re.findall(r'class="ui-finding[ "]', html)
check("the Audit page renders (200)", r.status_code == 200, f"status {r.status_code}")
check("the Audit page carries one finding, an INFO", len(findings) == 1 and 'ui-badge-info' in html, f"{len(findings)} findings")
check("the INFO uses the shared wording: No audit logs in this must-gather - looked for audit_logs/ (kube-apiserver, openshift-apiserver, oauth-apiserver, oauth-server); trimmed gather",
      'No audit logs in this must-gather' in text and 'looked for audit_logs/ (kube-apiserver, openshift-apiserver, oauth-apiserver, oauth-server); trimmed gather' in text, text[:300])
check("no content panel, controls, chart or table under the strip (the strip is the whole page)",
      'id="audit-events"' not in html and '<canvas' not in html and '<table' not in html and '<input' not in html and '<select' not in html and 'ae-search' not in html,
      f"panel {'id=\"audit-events\"' in html}, canvas {'<canvas' in html}, table {'<table' in html}, input {'<input' in html}")
check("no \"audit-only\" wording and no empty-state block", 'audit-only' not in html.lower() and 'empty-state' not in html and 'ui-empty' not in html)
# the panel structure stays the one card when there is data: nothing else changed in the template's data branch
check("the template keeps its data branch (the search form id) for a gather with audit logs", 'ae-search' in open(os.path.join(BACKEND, 'templates', 'tabs', 'mustgather_audit.html'), encoding='utf-8').read())

# ---- the search endpoint answers cleanly ----
r = post('/audit_events_search', {'directory': MG})
j = r.get_json() if r.is_json else None
check("/audit_events_search answers 200 with no events and no error for a gather without audit logs",
      r.status_code == 200 and isinstance(j, dict) and j.get('events') == [] and not j.get('error') and int(j.get('total') or 0) == 0,
      f"status {r.status_code}, keys {sorted(j.keys())[:12] if isinstance(j, dict) else j}")
r = post('/audit_events_search', {'directory': MG, 'query': {'verbs': ['get'], 'text': 'kube-system'}})
j = r.get_json() if r.is_json else None
check("/audit_events_search with filters answers 200 and empty too", r.status_code == 200 and isinstance(j, dict) and j.get('events') == [] and not j.get('error'), f"status {r.status_code}")

shutil.rmtree(TMP, ignore_errors=True)
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
