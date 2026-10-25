"""Log viewer / report parsing routes (sosreport & mustgather tabs)."""
import os
import importlib

from flask import Blueprint, render_template, request, jsonify, session

log_viewer = Blueprint('log_viewer', __name__)

parsed_cache = {}

PARSERS = {
    'sosreport': {
        'system': {
            'module': 'parsers.sosreport.system',
            'icon': 'fas fa-desktop',
            'label': 'System',
            'sub_tabs': {
                'processes': {
                    'module': 'parsers.sosreport.processes',
                    'icon': 'fas fa-tasks',
                    'label': 'Processes'
                },
                'pci_devices': {
                    'module': 'parsers.sosreport.pci_devices',
                    'icon': 'fas fa-microchip',
                    'label': 'PCI Devices'
                },
                'dmidecode': {
                    'module': 'parsers.sosreport.dmidecode',
                    'icon': 'fas fa-server',
                    'label': 'System Information'
                },
                'sched_debug': {
                    'module': 'parsers.sosreport.sched_debug',
                    'icon': 'fas fa-tachometer-alt',
                    'label': 'Scheduler Debug'
                },
                'services': {
                    'module': 'parsers.sosreport.services',
                    'icon': 'fas fa-cogs',
                    'label': 'Services'
                },
                'cstates': {
                    'module': 'parsers.sosreport.cstates',
                    'icon': 'fas fa-power-off',
                    'label': 'C States'
                },
            }
        },
        'openstack': {
            'module': 'parsers.sosreport.openstack',
            'icon': 'fas fa-cloud',
            'label': 'OpenStack',
            'sub_tabs': {
                'openstack_dpdk': {
                    'module': 'parsers.sosreport.openstack_dpdk',
                    'icon': 'fas fa-server',
                    'label': 'DPDK'
                },
                'haproxy': {
                    'module': 'parsers.sosreport.haproxy',
                    'icon': 'fas fa-balance-scale',
                    'label': 'HAProxy'
                },
                'pacemaker': {
                    'module': 'parsers.sosreport.pacemaker',
                    'icon': 'fas fa-heartbeat',
                    'label': 'Pacemaker'
                },
            },
        },
        'disk': {
            'module': 'parsers.sosreport.disk',
            'icon': 'fas fa-hdd',
            'label': 'Disk',
            'sub_tabs': {
                'disk_lvm': {
                    'module': 'parsers.sosreport.disk_lvm',
                    'icon': 'fas fa-layer-group',
                    'label': 'Logical Volume Management'
                },
                'disk_usage': {
                    'module': 'parsers.sosreport.disk_usage',
                    'icon': 'fas fa-folder-open',
                    'label': 'Disk Usage'
                },
            }
        },
        'cgroups': {
            'module': 'parsers.sosreport.cgroups',
            'icon': 'fas fa-chart-pie',
            'label': 'Control Groups',
            'sub_tabs': {
                'cgroups_cpu': {
                    'module': 'parsers.sosreport.cgroups_cpu',
                    'icon': 'fas fa-microchip',
                    'label': 'CPU Accounting'
                },
                'cgroups_memory': {
                    'module': 'parsers.sosreport.cgroups_memory',
                    'icon': 'fas fa-tachometer-alt',
                    'label': 'Memory Accounting'
                },
            }
        },
        'network': {
            'module': 'parsers.sosreport.network',
            'icon': 'fas fa-network-wired',
            'label': 'Network',
            'sub_tabs': {
                'network_stats': {
                    'module': 'parsers.sosreport.network_stats',
                    'icon': 'fas fa-chart-line',
                    'label': ' Network Interface Statistics'
                },
                'network_flow': {
                    'module': 'parsers.sosreport.network_flow',
                    'icon': 'fas fa-project-diagram',
                    'label': 'Flow Visualization'
                },
            }
        },
        'sar': {
            'module': 'parsers.sosreport.sar',
            'icon': 'fas fa-chart-bar',
            'label': 'System Activity Report',
            'sub_tabs': {
                'sar_cpu': {
                    'module': 'parsers.sosreport.sar_cpu',
                    'icon': 'fas fa-microchip',
                    'label': 'CPU Usage'
                },
                'sar_memory': {
                    'module': 'parsers.sosreport.sar_memory',
                    'icon': 'fas fa-memory',
                    'label': 'Memory Usage'
                },
                'sar_network': {
                    'module': 'parsers.sosreport.sar_network',
                    'icon': 'fas fa-network-wired',
                    'label': 'Network Usage'
                },
                'sar_disk': {
                    'module': 'parsers.sosreport.sar_disk',
                    'icon': 'fas fa-hdd',
                    'label': 'Disk Usage'
                },
            }
        },
        'kernel': {
            'module': 'parsers.sosreport.kernel',
            'icon': 'fas fa-microchip',
            'label': 'Kernel',
            'sub_tabs': {
                'kernel_stack_traces': {
                    'module': 'parsers.sosreport.kernel_stack_traces',
                    'icon': 'fas fa-exclamation-triangle',
                    'label': 'Stack Traces'
                },
                'kernel_hung_task': {
                    'module': 'parsers.sosreport.kernel_hung_task',
                    'icon': 'fas fa-hourglass-half',
                    'label': 'Hung Tasks'
                },
                'kernel_oom_killer': {
                    'module': 'parsers.sosreport.kernel_oom_killer',
                    'icon': 'fas fa-skull-crossbones',
                    'label': 'OOM Killer'
                },
            }
        },
        'log_collection': {
            'module': 'parsers.sosreport.log_collection',
            'icon': 'fas fa-stream',
            'label': 'Log Collection',
            'sub_tabs': {
                # The Log Viewer keeps its id: /load_tab and /get_tab_data
                # accept {"tab": "log_viewer"} as before (see _resolve_tab)
                'log_viewer': {
                    'module': 'parsers.sosreport.log_viewer',
                    'icon': 'fas fa-file-alt',
                    'label': 'Log Viewer'
                },
            }
        },
        'sos_report': {
            'module': 'parsers.sosreport.sos_report',
            'icon': 'fas fa-box',
            'label': 'Sos Report',
            'sub_tabs': {
                'blame': {
                    'module': 'parsers.sosreport.blame',
                    'icon': 'fas fa-chart-bar',
                    'label': 'Blame'
                },
            }
        },
    },
    'mustgather': {
        'system': {
            'module': 'parsers.mustgather.system',
            'icon': 'fas fa-info-circle',
            'label': 'Cluster',
            'sub_tabs': {
                'events': {
                  'module': 'parsers.mustgather.events',
                  'icon': 'fas fa-bell',
                  'label': 'Events'
                },
                'alerts': {
                    'module': 'parsers.mustgather.alerts',
                    'icon': 'fas fa-bell',
                    'label': 'Firing Alerts'
                },
            },
        },
        'compute': {
            'module': 'parsers.mustgather.compute',
            'icon': 'fas fa-microchip',
            'label': 'Compute',
            'sub_tabs': {
                'nodes': {
                    'module': 'parsers.mustgather.nodes',
                    'icon': 'fas fa-server',
                    'label': 'Nodes'
                },
                'mcp': {
                    'module': 'parsers.mustgather.mcp',
                    'icon': 'fas fa-server',
                    'label': 'Machine Config Pools'
                },
            },
        },
        'workloads': {
            'module': 'parsers.mustgather.workloads',
            'icon': 'fas fa-cogs',
            'label': 'Workloads',
            'sub_tabs': {
                'pod': {
                    'module': 'parsers.mustgather.pod',
                    'icon': 'fas fa-box',
                    'label': 'Pod'
                },
                'deployment': {
                    'module': 'parsers.mustgather.deployment',
                    'icon': 'fas fa-briefcase',
                    'label': 'Deployment'
                },
                'replicaset': {
                    'module': 'parsers.mustgather.replicaset',
                    'icon': 'fas fa-layer-group',
                    'label': 'Replica Set'
                },
                'daemonset': {
                    'module': 'parsers.mustgather.daemonset',
                    'icon': 'fas fa-cubes',
                    'label': 'Daemon Set'
                },
                'statefulset': {
                    'module': 'parsers.mustgather.statefulset',
                    'icon': 'fas fa-cube',
                    'label': 'Stateful Set'
                },
                'pdb': {
                    'module': 'parsers.mustgather.pdb',
                    'icon': 'fas fa-shield-alt',
                    'label': 'Pod Disruption Budget'
                },
            }
        },
        'security': {
            'module': 'parsers.mustgather.security',
            'icon': 'fas fa-shield-alt',
            'label': 'Security & Certificates',
            'sub_tabs': {
                'csr': {
                    'module': 'parsers.mustgather.csr',
                    'icon': 'fas fa-certificate',
                    'label': 'Certificate Signing Requests'
                },
                'tls_secrets': {
                    'module': 'parsers.mustgather.tls_secrets',
                    'icon': 'fas fa-lock',
                    'label': 'TLS Secret Expiration'
                },
            }
        },
        # The API audit logs (audit_logs/): one page, an explorer over every event
        'audit': {
            'module': 'parsers.mustgather.audit',
            'icon': 'fas fa-shield-alt',
            'label': 'Audit'
        },
        # Last on purpose: the sizes of what the must-gather holds; the Log Viewer under it as in a sosreport (the
        # shared viewer, tabs/_log_view.html, over the container, host service and node logs). A deep link
        # {"tab": "log_viewer"} resolves to the group (_resolve_tab); {"tab": "log_collection"} opens the group page.
        'log_collection': {
            'module': 'parsers.mustgather.log_collection',
            'icon': 'fas fa-stream',
            'label': 'Log Collection',
            'sub_tabs': {
                'log_viewer': {
                    'module': 'parsers.mustgather.log_viewer',
                    'icon': 'fas fa-file-alt',
                    'label': 'Log Viewer'
                },
            }
        },
    }
}
def _report_directory(raw):
    """
    Resolve a directory the client sent (see backend/reports_root.py: in the
    container only the reports volume is browsable). Returns (path, None)
    or (None, refusal-response).
    """
    from reports_root import ReportsRootError, resolve_directory
    if not raw or not isinstance(raw, str):
        return None, (jsonify({"error": "Invalid directory path."}), 400)
    try:
        resolved = resolve_directory(raw)
    except ReportsRootError as exc:
        return None, (jsonify({"error": str(exc)}), 403)
    if not os.path.isdir(resolved):
        return None, (jsonify({"error": "Invalid directory path."}), 400)
    return resolved, None


@log_viewer.route("/", methods=["GET", "POST"])
def index():
    session.pop('report_type', None)
    session.pop('uploaded_dir', None)
    parsed_cache.clear()

    context = {}
    if request.method == "POST":
        report_type = request.form['report_type']
        uploaded_dir, refusal = _report_directory(request.form.get('directory'))

        if refusal:
            context['error'] = "Invalid directory path."
            return render_template("index.html", **context)

        session['report_type'] = report_type
        session['uploaded_dir'] = uploaded_dir

        tabs_metadata = []
        for tab, tab_info in PARSERS[report_type].items():
            tab_entry = {
                'tab_name': tab,
                'icon': tab_info.get('icon', ''),
                'label': tab_info.get('label', tab.capitalize()),
                'has_sub_tabs': 'sub_tabs' in tab_info,
                'sub_tabs': []
            }

            if 'sub_tabs' in tab_info:
                for sub_tab, sub_tab_info in tab_info['sub_tabs'].items():
                    sub_tab_entry = {
                        'tab_name': sub_tab,
                        'icon': sub_tab_info.get('icon', ''),
                        'label': sub_tab_info.get('label', sub_tab.capitalize())
                    }
                    tab_entry['sub_tabs'].append(sub_tab_entry)

            tabs_metadata.append(tab_entry)

        return render_template("layout.html",
                               tabs=tabs_metadata,
                               report_type=report_type,
                               uploaded_dir=uploaded_dir)

    return render_template("index.html")


@log_viewer.route("/list_reports", methods=["POST"])
def list_reports():
    """List available mustgather and sosreport directories in specified folder"""
    try:
        # Get directory from request, default to Downloads
        data = request.json or {}
        from reports_root import ReportsRootError, default_directory, resolve_directory
        directory = data.get('directory') or default_directory()

        # "Downloads" (a bare name) is relative to the home directory - or to
        # the reports root when one is configured, which is also the only
        # tree that may be listed then.
        try:
            target_dir = resolve_directory(directory)
        except ReportsRootError as exc:
            return jsonify({"error": str(exc), "reports": []}), 403

        if not os.path.isdir(target_dir):
            return jsonify({"reports": []})

        reports = []

        # Scan target directory for report directories
        try:
            for item in os.listdir(target_dir):
                item_path = os.path.join(target_dir, item)

                # Only include directories
                if not os.path.isdir(item_path):
                    continue

                # Determine report type based on directory name patterns
                report_type = None
                if 'sosreport' in item.lower():
                    report_type = 'sosreport'
                elif 'must-gather' in item.lower() or 'mustgather' in item.lower() or item.lower().startswith('inspect'):
                    report_type = 'mustgather'

                if report_type:
                    # Get directory stats
                    stat_info = os.stat(item_path)

                    reports.append({
                        'name': item,
                        'path': item_path,
                        'type': report_type,
                        'modified': stat_info.st_mtime
                    })
        except Exception as e:
            print(f"Error scanning {target_dir} directory: {e}")

        # Sort by modification time (newest first)
        reports.sort(key=lambda x: x['modified'], reverse=True)

        return jsonify({"reports": reports})

    except Exception as e:
        return jsonify({"error": str(e), "reports": []}), 500


@log_viewer.app_template_filter('wbr')
def wbr_filter(value):
    """A break opportunity (<wbr>) after / . _ : = in an identifier (a path, an image reference, a namespace/name),
    so a wrapped table cell breaks at a readable place rather than mid-word; the value is escaped first."""
    import re
    from markupsafe import Markup, escape
    text = str(escape('' if value is None else value))
    return Markup(re.sub(r'([/._:=])(?=\S)', r'\1<wbr>', text))


@log_viewer.route("/get_tabs", methods=["POST"])
def get_tabs():
    """Get tab metadata for a given report type and directory"""
    report_type = request.json.get("report_type")
    directory = request.json.get("directory")

    if not report_type or not directory:
        return jsonify({"error": "Missing report_type or directory"}), 400

    directory, refusal = _report_directory(directory)
    if refusal:
        return refusal

    if report_type not in PARSERS:
        return jsonify({"error": f"Unknown report type: {report_type}"}), 400

    # Clear cache for any previously loaded directories to prevent stale data
    # Keep only cache entries for the current directory
    keys_to_remove = [key for key in parsed_cache.keys() if not key.startswith(f"{directory}:")]
    for key in keys_to_remove:
        del parsed_cache[key]

    tabs_metadata = []
    for tab, tab_info in PARSERS[report_type].items():
        tab_entry = {
            'tab_name': tab,
            'icon': tab_info.get('icon', ''),
            'label': tab_info.get('label', tab.capitalize()),
            'has_sub_tabs': 'sub_tabs' in tab_info,
            'sub_tabs': []
        }

        if 'sub_tabs' in tab_info:
            for sub_tab, sub_tab_info in tab_info['sub_tabs'].items():
                sub_tab_entry = {
                    'tab_name': sub_tab,
                    'icon': sub_tab_info.get('icon', ''),
                    'label': sub_tab_info.get('label', sub_tab.capitalize())
                }
                tab_entry['sub_tabs'].append(sub_tab_entry)

        tabs_metadata.append(tab_entry)

    return jsonify({
        "tabs": tabs_metadata,
        "report_type": report_type,
        "directory": directory
    })


def _resolve_tab(report_type, tab, sub_tab):
    """A sub-tab asked for by its own id ({"tab": "log_viewer"}, the way
    deep links and older callers address the Log Viewer since it moved
    under Log Collection) resolves to its group: (group, sub_tab).
    Anything else comes back unchanged."""
    groups = PARSERS.get(report_type) or {}
    if tab in groups or sub_tab or not tab:
        return tab, sub_tab
    for group, info in groups.items():
        if tab in (info.get('sub_tabs') or {}):
            return group, tab
    return tab, sub_tab


@log_viewer.route("/load_tab", methods=["POST"])
def load_tab():
    report_type = request.json.get("report_type")
    tab, sub_tab = _resolve_tab(report_type, request.json.get("tab"), request.json.get("sub_tab"))
    uploaded_dir = request.json.get("directory")

    uploaded_dir, refusal = _report_directory(uploaded_dir)
    if refusal:
        return refusal

    cache_key = f"{uploaded_dir}:{report_type}:{tab}:{sub_tab if sub_tab else 'main'}"

    if sub_tab:
        template = f"tabs/{report_type}_{sub_tab}.html"
    else:
        template = f"tabs/{report_type}_{tab}.html"

    # the parser module (needed on a cache hit too: the Findings strip is read from it)
    if sub_tab:
        module_path = PARSERS[report_type][tab]['sub_tabs'][sub_tab]['module']
    else:
        module_path = PARSERS[report_type][tab]['module']

    if cache_key in parsed_cache:
        data = parsed_cache[cache_key]
    else:
        try:
            module = importlib.import_module(module_path)
            data = module.parse(uploaded_dir)

            parsed_cache[cache_key] = data

        except Exception as e:
            return jsonify({"error": str(e)}), 500

    html = render_template(template, data=data, directory=uploaded_dir, findings=_findings_for(cache_key, module_path, uploaded_dir, data))
    return jsonify({"html": html})


def _findings_for(cache_key, module_path, directory, data):
    """The Findings strip of a tab (parsers/findings.py): the parser's findings(directory) when it defines one (the
    SAR tabs, whose parse() result is the chart's data keyed by day), else the `findings` list in the parsed data.
    Cached next to the parsed data."""
    key = cache_key + ':findings'
    if key in parsed_cache:
        return parsed_cache[key]
    items = []
    try:
        module = importlib.import_module(module_path)
        if hasattr(module, 'findings'):
            items = module.findings(directory) or []
        elif isinstance(data, dict):
            items = data.get('findings') or []
    except Exception:  # noqa: BLE001 - a findings error never takes the page down
        items = []
    parsed_cache[key] = items
    return items


@log_viewer.route("/audit_event_body", methods=["POST"])
def audit_event_body():
    """The unmasked request or response body of one sampled audit event
    (the Audit pages' per-event Reveal). Served from the scan's in-memory
    store only, never from a page's HTML; the directory goes through the
    same containment as every tab."""
    data = request.json or {}
    directory, refusal = _report_directory(data.get("directory"))
    if refusal:
        return refusal
    part = data.get("part")
    if part not in ("request", "response"):
        return jsonify({"error": "part must be request or response"}), 400
    from parsers.mustgather import audit_logs
    text = audit_logs.body(directory, str(data.get("audit_id") or ""), part)
    if text is None:
        return jsonify({"error": "no such sampled event body"}), 404
    return jsonify({"body": text})


@log_viewer.route("/audit_events_search", methods=["POST"])
def audit_events_search():
    """Audit > Events: the on-demand search over the audit files
    (parsers/mustgather/audit_search.py). The directory goes through the
    same containment as every tab; the query is validated field by field
    (plain substrings, known verbs, a status class or code, a time range,
    a limit up to 1000, a cursor from an earlier answer) and a bad one is
    a 400; the events come back masked."""
    data = request.json if isinstance(request.json, dict) else {}
    directory, refusal = _report_directory(data.get("directory"))
    if refusal:
        return refusal
    from parsers.mustgather import audit_search
    raw = data.get("query") if isinstance(data.get("query"), dict) else {k: v for k, v in data.items() if k != "directory"}
    base_day, first_ts = audit_search.capture_bounds(directory)
    query, error = audit_search.validate(raw, base_day, first_ts)
    if error:
        return jsonify({"error": error}), 400
    result = audit_search.search(directory, query)
    if not result.get("ok"):
        return jsonify(result), 429 if result.get("error") == "busy" else 409
    return jsonify(result)


@log_viewer.route("/audit_events_cancel", methods=["POST"])
def audit_events_cancel():
    """Audit > Events: the page's Cancel button. Stops the directory's running
    search (what a newer search for the same directory does by itself): the
    scan raises out at its next check and answers cancelled, which the page
    has already dropped. The directory goes through the same containment."""
    data = request.json if isinstance(request.json, dict) else {}
    directory, refusal = _report_directory(data.get("directory"))
    if refusal:
        return refusal
    from parsers.mustgather import audit_search
    audit_search.cancel(directory)
    return jsonify({"ok": True})


@log_viewer.route("/mustgather_log_search", methods=["POST"])
def mustgather_log_search():
    """The must-gather Log Viewer's paged search (parsers/mustgather/log_viewer.py): one page of rows from the
    selected logs (only files the gather lists, inside its directory) for the date range and the optional terms,
    with the cursor to continue from; a bad request is a 400, a cancelled one (a newer search over the same gather,
    or /mustgather_log_cancel) a 409."""
    data = request.json if isinstance(request.json, dict) else {}
    directory, refusal = _report_directory(data.get("directory"))
    if refusal:
        return refusal
    from parsers.mustgather import log_viewer as mg_log_viewer
    query, error = mg_log_viewer.validate(data, directory)
    if error:
        return jsonify({"error": error}), 400
    result = mg_log_viewer.search(directory, query)
    if not result.get("ok"):
        return jsonify(result), 409
    return jsonify(result)


@log_viewer.route("/mustgather_log_date_range", methods=["POST"])
def mustgather_log_date_range():
    """The must-gather Log Viewer's Get Date Range: the earliest and latest timestamps of the selected logs (the head
    and tail of each, every line format the search knows, .gz included), and which of them carry no timestamps at
    all - those are listed, never an error. Only logs the gather lists, inside its directory."""
    data = request.json if isinstance(request.json, dict) else {}
    directory, refusal = _report_directory(data.get("directory"))
    if refusal:
        return refusal
    from parsers.mustgather import log_viewer as mg_log_viewer
    paths = data.get("paths") or data.get("log_paths") or []
    chosen, error = mg_log_viewer.chosen_sources(paths, directory)
    if error:
        return jsonify({"error": error}), 400
    return jsonify(mg_log_viewer.date_range(directory, chosen))


@log_viewer.route("/mustgather_log_cancel", methods=["POST"])
def mustgather_log_cancel():
    """The must-gather Log Viewer's Abort: stops the gather's running search page."""
    data = request.json if isinstance(request.json, dict) else {}
    directory, refusal = _report_directory(data.get("directory"))
    if refusal:
        return refusal
    from parsers.mustgather import log_viewer as mg_log_viewer
    mg_log_viewer.cancel(directory)
    return jsonify({"ok": True})


@log_viewer.route("/get_tab_data", methods=["POST"])
def get_tab_data():
    """Get raw JSON data for a tab (for AI context)"""
    report_type = request.json.get("report_type")
    tab, sub_tab = _resolve_tab(report_type, request.json.get("tab"), request.json.get("sub_tab"))
    uploaded_dir = request.json.get("directory")

    uploaded_dir, refusal = _report_directory(uploaded_dir)
    if refusal:
        return refusal

    cache_key = f"{uploaded_dir}:{report_type}:{tab}:{sub_tab if sub_tab else 'main'}"

    # the parser module (needed on a cache hit too: the Findings strip is read from it)
    if sub_tab:
        module_path = PARSERS[report_type][tab]['sub_tabs'][sub_tab]['module']
    else:
        module_path = PARSERS[report_type][tab]['module']

    if cache_key in parsed_cache:
        data = parsed_cache[cache_key]
    else:
        try:
            module = importlib.import_module(module_path)
            data = module.parse(uploaded_dir)

            parsed_cache[cache_key] = data

        except Exception as e:
            return jsonify({"error": str(e)}), 500

    # Return raw JSON data instead of rendered HTML
    return jsonify({"data": data})


def _paths_within(base_dir, paths):
    """Keep only the entries of `paths` that resolve INSIDE base_dir.

    Caller-supplied log paths are opened by the sosreport parsers, and these
    endpoints are reachable from the diagnostics iframe's proxied API
    allowlist - so every path is contained here before any file is opened
    (symlinks resolved via realpath so a link out of the report tree does
    not count as "inside"). Returned paths are the caller's own strings
    (with ~ expanded) so the parsers' path-based log-type detection sees the
    same values as before.
    """
    base = os.path.realpath(os.path.expanduser(base_dir))
    safe = []
    for candidate in paths or []:
        if not isinstance(candidate, str) or not candidate:
            continue
        expanded = os.path.expanduser(candidate)
        real = os.path.realpath(expanded)
        if real == base or real.startswith(base + os.sep):
            safe.append(expanded)
    return safe


@log_viewer.route("/parse_log_viewer_stream", methods=["POST"])
def parse_log_viewer_stream():
    """Stream log entries progressively using Server-Sent Events"""
    from flask import Response, stream_with_context
    import json

    uploaded_dir = request.json.get("directory")
    start_date = request.json.get("start_date")
    end_date = request.json.get("end_date")
    log_paths = request.json.get("log_paths", [])
    # the filters applied while streaming (the viewer sends what its fields hold at Load Logs): plain substrings,
    # any of query / none of exclude over "host process message", a level, a process - never a pattern
    def terms(key):
        v = request.json.get(key) or []
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, list) or any(not isinstance(t, str) for t in v):
            return None
        return [t.lower()[:200] for t in v if t.strip()][:20]
    query, exclude = terms("query"), terms("exclude")
    level = request.json.get("level") or ""
    process = request.json.get("process") or ""
    if query is None or exclude is None or not isinstance(level, str) or not isinstance(process, str) or len(process) > 300:
        return jsonify({"error": "a search term is not a string"}), 400
    if level and level not in ("critical", "error", "warning", "info", "debug", "other"):
        return jsonify({"error": "the level is not one of critical, error, warning, info, debug, other"}), 400
    filtered = bool(query or exclude or level or process)

    uploaded_dir, refusal = _report_directory(uploaded_dir)
    if refusal:
        return refusal

    if not start_date or not end_date:
        return jsonify({"error": "Start and end dates are required."}), 400

    # Only files inside the report directory may be opened
    log_paths = _paths_within(uploaded_dir, log_paths)

    def keep(e):
        if level and e.get("severity") != level:
            return False
        if process and e.get("process") != process:
            return False
        if query or exclude:
            text = f"{e.get('hostname', '')} {e.get('process', '')} {e.get('message', '')}".lower()
            if query and not any(t in text for t in query):
                return False
            if exclude and any(t in text for t in exclude):
                return False
        return True

    def generate():
        try:
            from parsers.sosreport import log_viewer

            matched = 0
            # Stream entries as they're parsed
            for chunk in log_viewer.parse_date_range_stream(uploaded_dir, start_date, end_date, log_paths):
                if filtered:
                    # every chunk, the closing one included: the matches so far count as the total, what was read
                    # stays as scanned; an emptied chunk mid-stream is not sent
                    chunk = dict(chunk)
                    chunk["scanned"] = chunk.get("total_count", 0)
                    chunk["entries"] = [e for e in chunk.get("entries") or [] if keep(e)]
                    matched += len(chunk["entries"])
                    chunk["total_count"] = matched
                    if not chunk["entries"] and not chunk.get("done"):
                        continue
                # Send chunk as SSE
                yield f"data: {json.dumps(chunk)}\n\n"

            # Send completion event
            yield f"data: {json.dumps({'done': True})}\n\n"

        except Exception as e:
            print(f"[Log Viewer Stream] Error: {e}")
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@log_viewer.route("/parse_log_viewer_range", methods=["POST"])
def parse_log_viewer_range():
    """Parse log viewer with date range filter for performance (deprecated - use streaming)"""
    uploaded_dir = request.json.get("directory")
    start_date = request.json.get("start_date")
    end_date = request.json.get("end_date")
    log_paths = request.json.get("log_paths", [])
    limit = request.json.get("limit")  # Optional: for pagination
    offset = request.json.get("offset", 0)  # Optional: for pagination

    uploaded_dir, refusal = _report_directory(uploaded_dir)
    if refusal:
        return refusal

    # Only files inside the report directory may be opened
    log_paths = _paths_within(uploaded_dir, log_paths)

    if not start_date or not end_date:
        return jsonify({"error": "Start and end dates are required."}), 400

    try:
        from parsers.sosreport import log_viewer
        data = log_viewer.parse_date_range(uploaded_dir, start_date, end_date, log_paths, limit, offset)
        return jsonify({"data": data})
    except Exception as e:
        print(f"[Log Viewer] Error parsing date range: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@log_viewer.route("/get_log_date_range", methods=["POST"])
def get_log_date_range():
    """Get date range from selected log files"""
    uploaded_dir = request.json.get("directory")
    log_paths = request.json.get("log_paths", [])

    uploaded_dir, refusal = _report_directory(uploaded_dir)
    if refusal:
        return refusal

    if not log_paths:
        return jsonify({"error": "No log files selected."}), 400

    try:
        from parsers.sosreport import log_viewer

        min_date = None
        max_date = None

        # Security check - only paths that resolve inside the directory
        for log_path in _paths_within(uploaded_dir, log_paths):
            if os.path.exists(log_path):
                file_min, file_max, _ = log_viewer.extract_date_range(log_path)
                if file_min and file_max:
                    if min_date is None or file_min < min_date:
                        min_date = file_min
                    if max_date is None or file_max > max_date:
                        max_date = file_max

        if min_date and max_date:
            return jsonify({
                "date_range": {
                    "start": min_date.isoformat(),
                    "end": max_date.isoformat()
                }
            })
        else:
            return jsonify({"error": "Could not extract date range from selected files."}), 400

    except Exception as e:
        print(f"[Log Viewer] Error getting date range: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@log_viewer.route("/parse_haproxy_log", methods=["POST"])
def parse_haproxy_log():
    """Parse a specific HAProxy log file on-demand"""
    uploaded_dir = request.json.get("directory")
    log_file = request.json.get("log_file")

    if not uploaded_dir or not log_file:
        return jsonify({"error": "Missing directory or log_file parameter"}), 400

    # log_file is a bare file name inside the haproxy log directory (or the
    # '__all__' sentinel) - never a path component that could escape it.
    if log_file != '__all__' and (
            not isinstance(log_file, str) or os.path.basename(log_file) != log_file
            or log_file in ('.', '..')):
        return jsonify({"error": "Invalid log_file parameter"}), 400

    uploaded_dir, refusal = _report_directory(uploaded_dir)
    if refusal:
        return refusal

    try:
        # Import haproxy parser
        from parsers.sosreport import haproxy

        log_dir = haproxy.haproxy_log_dir(uploaded_dir)   # the container layout, else a plain host's var/log
        log_data = haproxy.parse_haproxy_logs(log_dir, log_file)   # the parser dates the lines with the report's year

        if log_data:
            return jsonify({"data": log_data})
        else:
            return jsonify({"error": "Failed to parse log file"}), 500

    except Exception as e:
        return jsonify({"error": str(e)}), 500

