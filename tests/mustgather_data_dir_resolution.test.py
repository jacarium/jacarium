#!/usr/bin/env python3
"""
Guards against the "must-gather from registry.redhat.io parses as empty" bug.

Every must-gather archive nests the actual cluster dump inside a subdirectory
named after the sanitized image reference used to collect it. Each of the 14
mustgather parsers used to carry a verbatim copy of this descent logic:

    for entry in os.listdir(directory):
        inner = os.path.join(directory, entry)
        if os.path.isdir(inner) and (entry.startswith("quay") or entry.startswith("inspect")):
            directory = inner
            break

That only recognized quay.io-pulled images ("quay-io-...") and `oc adm
inspect` dumps ("inspect..."). A must-gather collected from
registry.redhat.io produces "registry-redhat-io-..." instead, so no parser
ever descended and the whole Diagnostics report came back empty.

The fix extracts the logic into one shared helper,
backend/parsers/mustgather/_common.py:resolve_data_dir(), which

  1. keeps the old name-prefix match (quay/inspect) verbatim and adds
     "registry" (registry.redhat.io, registry.connect.redhat.com, ...), and
  2. falls back to structural detection: whichever subdirectory itself
     contains cluster-scoped-resources/ or namespaces/ is the image dir -
     registry-agnostic, so a disconnected mirror / ghcr.io image works too.

This test is self-contained with NO test framework. It builds temp directory
trees mimicking real must-gather layouts and asserts:
  - quay-io-... and inspect... layouts resolve exactly as before (no
    regression for archives that already worked),
  - registry-redhat-io-... resolves (the reported bug),
  - an arbitrary mirror-named image dir resolves via the structural fallback,
  - a directory already AT the dump level, or with no image dir at all, is
    returned unchanged, and a nonexistent path does not raise,
  - every parser module in backend/parsers/mustgather/ that reads the raw
    directory actually uses the shared helper (no stale private copies), and
  - an end-to-end check: the real system.py parser extracts the cluster
    version from a synthetic registry-redhat-io-... must-gather.

Run:  backend/venv/bin/python tests/mustgather_data_dir_resolution.test.py
      (only needs stdlib + pyyaml, which system.py imports)
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print('%s: %s%s' % ('PASS' if cond else 'FAIL', name, (' | ' + str(detail)) if detail else ''))


from parsers.mustgather._common import resolve_data_dir  # noqa: E402


def make_gather(root, image_dir_name, payload=('cluster-scoped-resources', 'namespaces')):
    """Create a directory tree shaped like a real extracted must-gather."""
    gather = os.path.join(root, 'must-gather.local.123')
    os.makedirs(gather)
    # top-level files must-gather always writes next to the image dir
    with open(os.path.join(gather, 'timestamp'), 'w') as f:
        f.write('2026-07-28 10:00:00.000000000 +0000 UTC m=+0.1\n'
                '2026-07-28 10:05:00.000000000 +0000 UTC m=+300.1\n')
    with open(os.path.join(gather, 'event-filter.html'), 'w') as f:
        f.write('<html></html>')
    inner = None
    if image_dir_name:
        inner = os.path.join(gather, image_dir_name)
        os.makedirs(inner)
        for p in payload:
            os.makedirs(os.path.join(inner, p))
        with open(os.path.join(inner, 'version'), 'w') as f:
            f.write('4.16.0\n')
    return gather, inner


tmp = tempfile.mkdtemp(prefix='mustgather-resolve-test-')
exit_code = 1
try:
    # ---------- 1. layouts that already worked (regression guard) ----------
    quay_name = ('quay-io-openshift-release-dev-ocp-v4-0-art-dev-sha256-'
                 '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')
    gather, inner = make_gather(os.path.join(tmp, 'quay'), quay_name)
    check('quay-io-... image dir resolves (pre-existing behavior)',
          resolve_data_dir(gather) == inner, resolve_data_dir(gather))

    gather, inner = make_gather(os.path.join(tmp, 'inspect'),
                                'inspect.local.5678901234567890')
    check('inspect... dir resolves (pre-existing behavior)',
          resolve_data_dir(gather) == inner, resolve_data_dir(gather))

    # old code matched quay/inspect dirs by NAME alone, without looking at
    # their contents - keep that exact behavior so nothing regresses
    gather, inner = make_gather(os.path.join(tmp, 'quay-empty'), quay_name, payload=())
    check('quay-io-... dir resolves even when its payload dirs are absent '
          '(identical to old name-only match)',
          resolve_data_dir(gather) == inner, resolve_data_dir(gather))

    # ---------- 2. the reported bug: registry.redhat.io ----------
    rh_name = ('registry-redhat-io-openshift4-ose-must-gather-rhel9-sha256-'
               'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890')
    gather, inner = make_gather(os.path.join(tmp, 'redhat'), rh_name)
    check('registry-redhat-io-... image dir resolves (the reported bug)',
          resolve_data_dir(gather) == inner, resolve_data_dir(gather))

    # registry.connect.redhat.com-style names ride on the same prefix
    gather, inner = make_gather(os.path.join(tmp, 'connect'),
                                'registry-connect-redhat-com-some-partner-mg-sha256-feed')
    check('registry-connect-redhat-com-... image dir resolves',
          resolve_data_dir(gather) == inner, resolve_data_dir(gather))

    # ---------- 3. any other registry: structural fallback ----------
    gather, inner = make_gather(os.path.join(tmp, 'mirror'),
                                'mirror-corp-example-com-5000-ocp4-must-gather-sha256-cafe')
    check('unknown mirror image dir resolves via payload-dir detection',
          resolve_data_dir(gather) == inner, resolve_data_dir(gather))

    gather, inner = make_gather(os.path.join(tmp, 'ghcr'),
                                'ghcr-io-someorg-must-gather-sha256-beef',
                                payload=('namespaces',))
    check('image dir with only namespaces/ still resolves structurally',
          resolve_data_dir(gather) == inner, resolve_data_dir(gather))

    # ---------- 4. cases where descending would be wrong ----------
    # user points straight at the dump level (image dir already stripped)
    flat = os.path.join(tmp, 'flat')
    os.makedirs(os.path.join(flat, 'cluster-scoped-resources'))
    os.makedirs(os.path.join(flat, 'namespaces', 'openshift-etcd'))
    check('directory already at the dump level is returned unchanged',
          resolve_data_dir(flat) == flat, resolve_data_dir(flat))

    # nothing recognizable at all -> unchanged (old code also fell through)
    bare = os.path.join(tmp, 'bare')
    os.makedirs(os.path.join(bare, 'random-subdir'))
    check('directory with no image dir and no payload is returned unchanged',
          resolve_data_dir(bare) == bare, resolve_data_dir(bare))

    # nonexistent path must not raise (parsers rely on their own
    # missing-file handling downstream, exactly like the old inline loop)
    missing = os.path.join(tmp, 'does-not-exist')
    try:
        out = resolve_data_dir(missing)
        check('nonexistent path returns unchanged instead of raising', out == missing, out)
    except Exception as e:  # noqa: BLE001
        check('nonexistent path returns unchanged instead of raising', False, repr(e))

    # ---------- 5. no parser kept a stale private copy ----------
    pkg = os.path.join(BACKEND, 'parsers', 'mustgather')
    stale, missing_helper = [], []
    for fname in sorted(os.listdir(pkg)):
        if not fname.endswith('.py') or fname == '_common.py':
            continue
        with open(os.path.join(pkg, fname)) as fh:
            src = fh.read()
        if 'startswith("quay")' in src or "startswith('quay')" in src:
            stale.append(fname)
        # every parser that walks the raw directory must use the helper;
        # compute.py / workloads.py are section stubs that read nothing
        if 'os.listdir(directory)' in src or 'os.path.join(directory' in src:
            if 'resolve_data_dir' not in src:
                missing_helper.append(fname)
    check('no parser still carries its own quay/inspect prefix check', not stale, stale)
    check('every directory-reading parser goes through resolve_data_dir',
          not missing_helper, missing_helper)

    # ---------- 6. end to end through a real parser ----------
    try:
        import yaml  # noqa: F401
        have_yaml = True
    except ImportError:
        have_yaml = False
        print('SKIP: pyyaml not available, skipping the system.py end-to-end check '
              '(run with backend/venv/bin/python for full coverage)')
    if have_yaml:
        from parsers.mustgather import system as system_parser
        gather, inner = make_gather(os.path.join(tmp, 'e2e'), rh_name)
        cv_dir = os.path.join(inner, 'cluster-scoped-resources',
                              'config.openshift.io', 'clusterversions')
        os.makedirs(cv_dir)
        with open(os.path.join(cv_dir, 'version.yaml'), 'w') as f:
            yaml.safe_dump({'spec': {'channel': 'stable-4.16'},
                            'status': {'desired': {'version': '4.16.0'}}}, f)
        parsed = system_parser.parse(gather)
        check('system.py finds cluster version inside a registry-redhat-io dump',
              parsed.get('cluster_version', {}).get('version') == '4.16.0',
              parsed.get('cluster_version'))
        check('system.py still reads the top-level timestamp file',
              parsed.get('collection_timestamps', {}).get('first', '').startswith('2026-07-28'),
              parsed.get('collection_timestamps'))

    passed = sum(1 for _, ok in results if ok)
    print('\nSUMMARY: %d/%d passed' % (passed, len(results)))
    exit_code = 0 if passed == len(results) else 1
except Exception:  # noqa: BLE001
    import traceback
    print('TEST DRIVER ERROR:')
    traceback.print_exc()
finally:
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(exit_code)
