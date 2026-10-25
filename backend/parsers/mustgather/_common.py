"""Shared helpers for the must-gather parsers.

Every parser in this package receives the root of an extracted must-gather
archive. `oc adm must-gather` nests the actual cluster dump inside a
subdirectory named after the sanitized image reference used to collect it,
e.g.:

    must-gather.local.123/
        timestamp
        event-filter.html
        quay-io-openshift-release-dev-ocp-...-sha256-<hash>/
            timestamp
            version
            cluster-scoped-resources/
            namespaces/
            ...

That image directory's name depends entirely on which registry the image was
pulled from (quay.io, registry.redhat.io, a disconnected mirror, ...), so it
cannot be matched by name alone.
"""
import os

# Name prefixes of the image subdirectory. "quay" and "inspect" preserve the
# exact behavior every parser had before this helper existed; "registry"
# covers images pulled from registry.redhat.io, registry.connect.redhat.com,
# or any other host whose sanitized name starts with "registry-".
_IMAGE_DIR_PREFIXES = ("quay", "inspect", "registry")

# Entries whose presence marks a directory as holding the cluster dump
# itself. Used to recognize the image subdirectory regardless of which
# registry (an internal mirror, ghcr.io, ...) the image came from.
_DATA_MARKERS = ("cluster-scoped-resources", "namespaces")


def _has_data_markers(path):
    return any(os.path.isdir(os.path.join(path, marker)) for marker in _DATA_MARKERS)


def resolve_data_dir(directory):
    """Return the directory that actually contains the cluster dump.

    If ``directory`` holds an image-named subdirectory (see module docstring),
    return that subdirectory; otherwise return ``directory`` unchanged.

    Detection is two-step:

    1. Known name prefixes (quay/inspect/registry) - the quay and inspect
       prefixes replicate the old per-parser check verbatim, so archives that
       parsed correctly before keep resolving to the same place.
    2. Structural fallback - any subdirectory that itself contains the
       well-known must-gather payload directories (cluster-scoped-resources/
       or namespaces/) is treated as the image directory. This is registry
       agnostic, so dumps collected through any mirror still resolve. It is
       skipped when ``directory`` already contains the payload directly (the
       caller was already pointed at the dump).

    Never raises: on an unreadable/nonexistent path the input is returned
    as-is and the caller's own missing-file handling takes over, just as it
    did with the old inline loop.
    """
    try:
        entries = sorted(os.listdir(directory))
    except OSError:
        return directory

    subdirs = [e for e in entries if os.path.isdir(os.path.join(directory, e))]

    for entry in subdirs:
        if entry.startswith(_IMAGE_DIR_PREFIXES):
            return os.path.join(directory, entry)

    if not _has_data_markers(directory):
        for entry in subdirs:
            if _has_data_markers(os.path.join(directory, entry)):
                return os.path.join(directory, entry)

    return directory

# ---------------------------------------------------------------------------
# YAML: libyaml's C loader when PyYAML was built with it (5-10x faster on the
# multi-megabyte pod and event dumps of a large cluster), the pure one else;
# both are the SafeLoader (no object construction from untrusted documents).
# ---------------------------------------------------------------------------
import yaml  # noqa: E402

_LOADER = getattr(yaml, 'CSafeLoader', yaml.SafeLoader)


def safe_load(stream):
    return yaml.load(stream, Loader=_LOADER)


def safe_load_all(stream):
    return yaml.load_all(stream, Loader=_LOADER)


def list_items(doc, kind=None):
    """The items of a must-gather list file, always a list of dicts:
         - a *List document: its items; `items: null`, `items: []` and a missing key are an empty list (a valid,
           empty namespace - not an unreadable file);
         - a single object (a kind without List, e.g. one Secret): a one-item list;
         - None (an empty file, a `null` document) or anything that is not a mapping: [].
       kind, when given, keeps only the items of that kind (a stray object in a list is skipped)."""
    if not isinstance(doc, dict):
        return []
    if 'items' in doc or str(doc.get('kind') or '').endswith('List'):
        raw = doc.get('items')
        items = raw if isinstance(raw, list) else []
    else:
        items = [doc]
    out = [it for it in items if isinstance(it, dict)]
    if kind:
        out = [it for it in out if not it.get('kind') or it.get('kind') == kind]
    return out


def reason_of(exc):
    """A short, readable reason for a file that could not be read - never the raw exception text in the UI."""
    import yaml as _yaml
    if isinstance(exc, _yaml.YAMLError):
        mark = getattr(exc, 'problem_mark', None)
        where = f' (line {mark.line + 1})' if mark is not None else ''
        return f'not valid YAML{where}'
    if isinstance(exc, UnicodeDecodeError):
        return 'binary or non-UTF-8 content'
    if isinstance(exc, PermissionError):
        return 'no permission to read it'
    if isinstance(exc, FileNotFoundError):
        return 'the file is missing'
    if isinstance(exc, IsADirectoryError):
        return 'a directory where a file was expected'
    if isinstance(exc, OSError):
        return 'the file could not be read'
    if isinstance(exc, (AttributeError, TypeError, KeyError, ValueError)):
        return 'not the expected document shape'
    return 'could not be parsed'


def unreadable(path, exc, root=None):
    """The record of a file that could not be read: its path (relative to the gather when root is given) and the
    reason, for the Findings strip and the page."""
    rel = path
    if root:
        try:
            rel = os.path.relpath(path, root)
        except ValueError:
            rel = path
    return {'file': rel, 'reason': reason_of(exc), 'error': reason_of(exc)}


def unreadable_finding(records, what):
    """One WARN naming the files that could not be read (the first with its reason), or None."""
    from parsers.findings import finding
    records = [r for r in records if isinstance(r, dict) and r.get('file')]
    if not records:
        return None
    first = records[0]
    more = f" (+{len(records) - 1} more)" if len(records) > 1 else ''
    return finding('warn', f"{len(records)} {what} file{'s' if len(records) != 1 else ''} could not be read", f"{first['file']}: {first['reason']}{more}")


def collection_time(directory):
    """The must-gather's collection time (UTC) from its `timestamp` file, else now."""
    import re
    from datetime import datetime, timedelta, timezone
    p = os.path.join(directory, 'timestamp')
    try:
        with open(p, 'r', encoding='utf-8', errors='replace') as f:
            first = f.readline().strip()
        m = re.match(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.?\d* ([+-]\d{4})', first)
        if m:
            sign = 1 if m.group(2)[0] == '+' else -1
            off = timedelta(hours=sign * int(m.group(2)[1:3]), minutes=sign * int(m.group(2)[3:5]))
            return datetime.fromisoformat(m.group(1).replace(' ', 'T')).replace(tzinfo=timezone.utc) - off
    except OSError:
        pass
    return datetime.now(timezone.utc)
