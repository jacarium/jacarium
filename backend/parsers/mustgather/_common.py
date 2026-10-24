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
