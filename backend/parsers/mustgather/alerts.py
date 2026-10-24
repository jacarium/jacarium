import os
import json
import re
from datetime import datetime

from parsers.findings import finding, sort_findings, no_data

from parsers.mustgather._common import resolve_data_dir

def parse(directory):
    result = {
        'firing': [],
        'all': []
    }

    # Get collection timestamp from must-gather
    original_directory = directory
    timestamp_file = os.path.join(original_directory, "timestamp")
    collection_time = None

    if os.path.exists(timestamp_file):
        try:
            with open(timestamp_file, 'r') as f:
                lines = f.readlines()
                if len(lines) >= 1:
                    # Parse first line: "2026-04-13 14:02:58.640004158 -0700 PDT m=+0.146292020"
                    first_line = lines[0].strip()
                    datetime_match = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.?\d* ([+-]\d{4})', first_line)
                    if datetime_match:
                        dt_str = datetime_match.group(1)
                        tz_str = datetime_match.group(2)

                        # Parse timezone offset
                        tz_sign = 1 if tz_str[0] == '+' else -1
                        tz_hours = int(tz_str[1:3])
                        tz_minutes = int(tz_str[3:5])
                        from datetime import timedelta, timezone
                        tz_offset = timedelta(hours=tz_sign * tz_hours, minutes=tz_sign * tz_minutes)

                        # Parse datetime as naive, then convert to UTC
                        naive_dt = datetime.fromisoformat(dt_str.replace(' ', 'T'))
                        collection_time = naive_dt.replace(tzinfo=timezone.utc) - tz_offset
        except:
            pass

    # If we couldn't get collection time, fall back to current time
    if not collection_time:
        from datetime import timezone
        collection_time = datetime.now(timezone.utc)

    directory = resolve_data_dir(directory)

    # Look for monitoring/prometheus/rules.json
    rules_path = os.path.join(directory, "monitoring", "prometheus", "rules.json")

    if not os.path.exists(rules_path):
        result['findings'] = [no_data('No alert rules in this must-gather', ['monitoring/prometheus/rules.json'], 'trimmed gather (the monitoring stack was not collected)')]
        return result

    try:
        with open(rules_path, "r") as f:
            rules_data = json.load(f)

        if rules_data.get("status") != "success":
            return result

        groups = rules_data.get("data", {}).get("groups", [])

        for group in groups:
            group_name = group.get("name", "")
            rules = group.get("rules", [])

            for rule in rules:
                if rule.get("type") != "alerting":
                    continue

                rule_name = rule.get("name", "")
                state = rule.get("state", "inactive")
                labels = rule.get("labels", {})
                severity = labels.get("severity", "none")
                annotations = rule.get("annotations", {})
                alerts = rule.get("alerts", [])
                last_eval = rule.get("lastEvaluation", "")
                health = rule.get("health", "unknown")
                evaluation_time = rule.get("evaluationTime", 0)
                keep_firing_for = rule.get("keepFiringFor", 0)

                # Calculate age from lastEvaluation relative to collection time
                age_seconds = 0
                if last_eval:
                    try:
                        eval_time = datetime.fromisoformat(last_eval.replace('Z', '+00:00'))
                        age_diff = collection_time - eval_time
                        age_seconds = int(age_diff.total_seconds())
                    except:
                        age_seconds = 0

                # Get active since from first alert if exists
                active_since = ""
                if alerts and len(alerts) > 0:
                    active_since = alerts[0].get("activeAt", "")

                # Extract additional info from labels (not just severity)
                namespace = labels.get("namespace", "")

                # Get description from annotations
                description = annotations.get("description", "")
                summary = annotations.get("summary", "")
                runbook_url = annotations.get("runbook_url", "")

                alert_info = {
                    'name': rule_name,
                    'group': group_name,
                    'severity': severity,
                    'state': state,
                    'alerts_count': len(alerts),
                    'last_evaluation': last_eval,
                    'age_seconds': age_seconds,
                    'active_since': active_since,
                    'query': rule.get('query', ''),
                    'duration': rule.get('duration', 0),
                    'keep_firing_for': keep_firing_for,
                    'health': health,
                    'evaluation_time': evaluation_time,
                    'annotations': annotations,
                    'labels': labels,
                    'alerts': alerts,
                    'namespace': namespace,
                    'description': description,
                    'summary': summary,
                    'runbook_url': runbook_url,
                    'raw': rule
                }

                result['all'].append(alert_info)

                if state == "firing":
                    result['firing'].append(alert_info)

    except Exception as e:
        result['error'] = str(e)

    # firing first, then pending; critical before warning before info; the longest-firing first
    for key in ('all', 'firing'):
        result[key].sort(key=lambda al: (STATE_RANK.get(al['state'], 3), SEVERITY_RANK.get(al['severity'], 3), al.get('active_since') or 'z'))
    result['findings'] = findings_for(result)
    return result

STATE_RANK = {'firing': 0, 'pending': 1, 'inactive': 2}
SEVERITY_RANK = {'critical': 0, 'warning': 1, 'info': 2}


def findings_for(result):
    """The Findings strip: firing critical alerts (bad) and warnings (warn), each with its summary and namespace, the
    pending ones (info), the counts when nothing fires. The Watchdog alert (it fires on purpose) is left out."""
    out = []
    firing = [al for al in result.get('firing', []) if al.get('name') != 'Watchdog']
    for al in firing[:12]:
        sev = 'bad' if al.get('severity') == 'critical' else ('warn' if al.get('severity') == 'warning' else 'info')
        ns = al.get('namespace') or (al.get('labels') or {}).get('namespace') or ''
        out.append(finding(sev, f"{al['name']} firing ({al.get('severity', '?')})" + (f" x{al['alerts_count']}" if al.get('alerts_count', 0) > 1 else ''), (al.get('summary') or al.get('description') or '')[:240] + (f" [{ns}]" if ns else ''), tab='workloads', sub_tab='pod', query=ns or None, count=al.get('alerts_count') or 1))
    if len(firing) > 12:
        out.append(finding('info', f"{len(firing) - 12} more alerts firing", ', '.join(al['name'] for al in firing[12:20]) + (' …' if len(firing) > 20 else ''), count=len(firing) - 12))
    pending = [al for al in result.get('all', []) if al.get('state') == 'pending']
    if pending:
        out.append(finding('info', f"{len(pending)} alert{'s' if len(pending) != 1 else ''} pending", ', '.join(al['name'] for al in pending[:6]) + (' …' if len(pending) > 6 else ''), count=len(pending)))
    if not result.get('all'):
        out.append(finding('info', 'No alert rules in this must-gather', 'monitoring/prometheus/rules.json is missing'))
    elif not firing:
        out.append(finding('good', f"No alert firing ({len(result['all'])} rules evaluated)"))
    return sort_findings(out)
