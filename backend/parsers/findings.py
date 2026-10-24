"""The Findings strip every Diagnostics plugin can show at the top of its
page: the problems the parser found, worst first, each as one line with a
severity, a short title, the detail and, when another plugin shows more, a
link to it (optionally with a search term it should apply).

A parser builds its list with finding() and hands it to the template under
`findings`; tabs/_ui.html's findings() macro renders the strip (one shared
design: the severity badge, the square left accent, the link). The
severities, in order of urgency:

  bad    something is wrong now (a failed unit, a full filesystem, an OOM)
  warn   worth a look (a unit near its task limit, 85% used, high iowait)
  info   a fact that frames the rest (an estimated value, a missing capture)
  good   nothing found for a class of problem (shown when a page would be
         empty otherwise, so the absence is a statement)

Everything in a finding is report content and is escaped by the template.
"""

ORDER = {'bad': 0, 'warn': 1, 'info': 2, 'good': 3}

# The thresholds of a percentage, in one place: (warn, bad). A parser's Findings and the page's meters both read
# level(), so a bar's colour and the strip's severity never disagree.
THRESHOLDS = {
    'disk': (90, 95),        # a filesystem's blocks
    'inodes': (90, 95),
    'thin_pool': (90, 95),   # an LVM thin pool's data or metadata
    'tasks': (90, 95),       # a unit's tasks against TasksMax
    'memory': (90, 95),      # a unit's memory against its limit
    'pods': (80, 95),        # a node's pods against its allocatable count
    'cgroup': (90, 95),
}


def level(value, kind='disk', warn=None, bad=None):
    """'ok' / 'warn' / 'bad' for a percentage by the shared thresholds (or the given ones); None -> 'muted'."""
    if value is None:
        return 'muted'
    w, b = THRESHOLDS.get(kind, (90, 95))
    w = warn if warn is not None else w
    b = bad if bad is not None else b
    return 'bad' if value >= b else ('warn' if value >= w else 'ok')


def severity_of(role):
    """The Findings severity a meter role maps to ('ok' has none)."""
    return {'bad': 'bad', 'warn': 'warn'}.get(role)
BADGE = {'bad': 'bad', 'warn': 'warn', 'info': 'info', 'good': 'good'}


def finding(severity, title, detail='', tab=None, sub_tab=None, query=None, count=None):
    """One finding. tab / sub_tab name the plugin that shows more (the
    registry keys of log_viewer.PARSERS); query is the search term that
    page should apply when opened from the link (its [data-ui-search] field)."""
    if severity not in ORDER:
        severity = 'info'
    out = {'severity': severity, 'badge': BADGE[severity], 'title': str(title), 'detail': str(detail or '')}
    if count is not None:
        out['count'] = int(count)
    if tab:
        out['link'] = {'tab': tab, 'sub_tab': sub_tab, 'query': query or ''}
    return out


def no_data(what, looked=None, reason=None, severity='info'):
    """The one way to say a page has nothing to show: WHAT is missing, WHERE the parser looked and WHY, when known.
    A GOOD finding is for a check that ran on data; absence of data is never good - use this instead."""
    detail = ''
    if looked:
        detail = 'looked for ' + (', '.join(looked) if isinstance(looked, (list, tuple)) else str(looked))
    if reason:
        detail = (detail + '; ' if detail else '') + str(reason)
    return finding(severity, what, detail)


def sort_findings(items):
    """Worst first, then by count (largest first), then by title; stable."""
    return sorted(items, key=lambda f: (ORDER.get(f.get('severity'), 2), -(f.get('count') or 0), f.get('title', '')))


def summary(items):
    """{'bad': n, 'warn': n, 'info': n, 'good': n, 'total': n} for a strip's header."""
    out = {k: 0 for k in ORDER}
    for f in items:
        out[f.get('severity', 'info')] = out.get(f.get('severity', 'info'), 0) + 1
    out['total'] = len(items)
    return out


# ---------------------------------------------------------------------------
# human formatting, shared by the parsers that put numbers into a finding
# ---------------------------------------------------------------------------
def human_bytes(n, kib=False):
    """1536 -> '1.5 KiB' (or '1.5 MiB' for a value already in KiB)."""
    try:
        v = float(n)
    except (TypeError, ValueError):
        return ''
    units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
    i = 1 if kib else 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    return (f"{v:.0f} {units[i]}" if v >= 100 or i == 0 else f"{v:.1f} {units[i]}")


def human_pct(part, whole, digits=0):
    try:
        if not whole:
            return ''
        return f"{100.0 * float(part) / float(whole):.{digits}f}%"
    except (TypeError, ValueError, ZeroDivisionError):
        return ''


def human_count(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ''
    return f"{n:,}".replace(',', ' ')

# ---------------------------------------------------------------------------
# The strip of a parser whose result the page iterates (a dict keyed by
# namespace or node name, a list): parse() computes the findings and
# remember()s them under the report's directory; the module's findings(dir)
# recall()s them, parsing first when nothing is there (a process restart
# between the loader's parse and its findings call).
# ---------------------------------------------------------------------------
_STORE = {}


def remember(key, items):
    _STORE[key] = list(items or [])
    return _STORE[key]


def recall(key, compute):
    if key not in _STORE:
        try:
            compute()
        except Exception:  # noqa: BLE001 - the page shows its own error; no strip then
            return []
    return _STORE.get(key, [])
