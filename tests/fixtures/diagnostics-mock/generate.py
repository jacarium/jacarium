#!/usr/bin/env python3
"""Generate SYNTHETIC diagnostics reports for trying the Diagnostics page by hand.

    python3 tests/fixtures/diagnostics-mock/generate.py            # sosreport + must-gather into out/
    python3 tests/fixtures/diagnostics-mock/generate.py --large    # also a ~50k-line-journal sosreport
    python3 tests/fixtures/diagnostics-mock/generate.py --copy-to ~/Downloads

Writes, under --out (default: this directory's out/, which is git-ignored):

    sosreport-web-01-2026-10-13-abcdef/           extracted sosreport (what the app browses)
    sosreport-web-01-2026-10-13-abcdef.tar.xz     the same, archived the way sos does
    must-gather.local.1234567890/                 extracted must-gather
    must-gather.local.1234567890.tar.gz           the same, archived
    sosreport-web-02-2026-10-13-bigjrnl[.tar.xz]  only with --large

Standard library only; deterministic (fixed seed, fixed timestamps, fixed
archive metadata), so reruns produce byte-identical output. Every value in the
reports is invented - see README.md for the planted findings.
"""
import argparse
import gzip
import io
import os
import shutil
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mock_manifests
import mock_mustgather  # noqa: E402
import mock_sosreport  # noqa: E402

SOS_NAME = "sosreport-web-01-2026-10-13-abcdef"
OCP_NAME = "sosreport-ip-10-0-42-46-master-cluster-7bffs-master-2026-10-01-asqizwl"
OLD_NAME = "sosreport-old-01-2026-10-01-oldfmt"
SOS_LARGE_NAME = "sosreport-web-02-2026-10-13-bigjrnl"
MG_NAME = "must-gather.local.1234567890"
# Fixed mtime for every archive member: 2026-10-13 00:00:00 UTC
ARCHIVE_MTIME = 1791849600


def _reset(path):
    if os.path.isdir(path):
        shutil.rmtree(path)
    elif os.path.exists(path):
        os.remove(path)


def _add_tree(tar, root, arc_root):
    """Add `root` to `tar` as `arc_root` with sorted entries and fixed metadata."""
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel = os.path.relpath(dirpath, root)
        entries.append((dirpath, rel))
        for name in sorted(filenames):
            entries.append((os.path.join(dirpath, name), os.path.join(rel, name)))
    for full, rel in entries:
        arcname = arc_root if rel == "." else os.path.join(arc_root, rel)
        info = tar.gettarinfo(full, arcname=arcname)
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        info.mtime = ARCHIVE_MTIME
        info.mode = 0o755 if info.isdir() else 0o644
        if info.isfile():
            with open(full, "rb") as fh:
                tar.addfile(info, fh)
        else:
            tar.addfile(info)


def archive_xz(root, out_path):
    _reset(out_path)
    with tarfile.open(out_path, "w:xz", format=tarfile.GNU_FORMAT) as tar:
        _add_tree(tar, root, os.path.basename(root))


def archive_gz(root, out_path):
    _reset(out_path)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tar:
        _add_tree(tar, root, os.path.basename(root))
    with open(out_path, "wb") as fh:
        with gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0) as gz:
            gz.write(buf.getvalue())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(HERE, "out"), help="output directory (default: tests/fixtures/diagnostics-mock/out)")
    ap.add_argument("--large", action="store_true", help="also build the large sosreport variant (~50k journal lines)")
    ap.add_argument("--large-lines", type=int, default=50000, help="journal lines for the large variant (default 50000)")
    ap.add_argument("--no-archives", action="store_true", help="only write the extracted directories")
    ap.add_argument("--copy-to", metavar="DIR", help="also copy the extracted report directories into DIR (e.g. ~/Downloads, where the Diagnostics page looks by default)")
    args = ap.parse_args(argv)

    out = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(out, exist_ok=True)
    built = []

    sos_dir = os.path.join(out, SOS_NAME)
    _reset(sos_dir)
    mock_sosreport.build(sos_dir)
    built.append(sos_dir)
    if not args.no_archives:
        archive_xz(sos_dir, sos_dir + ".tar.xz")
        built.append(sos_dir + ".tar.xz")

    # Two manifest-only sosreport trees for the Sos Report / Blame tab: an
    # OpenShift master-like run (many plugins, failing ebpf commands, a
    # timeout) and an older sos without per-plugin timings
    for name, manifest in ((OCP_NAME, mock_manifests.ocp_master_manifest()), (OLD_NAME, mock_manifests.old_manifest())):
        d = os.path.join(out, name)
        _reset(d)
        os.makedirs(os.path.join(d, "sos_reports"))
        with open(os.path.join(d, "sos_reports", "manifest.json"), "w") as f:
            f.write(mock_manifests.dump(manifest))
        host = manifest["components"]["report"]["sysinfo"]["hostname"]
        with open(os.path.join(d, "hostname"), "w") as f:
            f.write(host + "\n")
        with open(os.path.join(d, "version.txt"), "w") as f:
            f.write(f"sosreport: {manifest['version']}\n")
        with open(os.path.join(d, "date"), "w") as f:
            f.write("Thu Oct  1 04:21:40 UTC 2026\n")
        built.append(d)

    mg_dir = os.path.join(out, MG_NAME)
    _reset(mg_dir)
    mock_mustgather.build(mg_dir)
    built.append(mg_dir)
    if not args.no_archives:
        archive_gz(mg_dir, mg_dir + ".tar.gz")
        built.append(mg_dir + ".tar.gz")

    if args.large:
        large_dir = os.path.join(out, SOS_LARGE_NAME)
        _reset(large_dir)
        # The same host story with a much longer journal and app log; the
        # hostname inside stays web-01 so the planted incidents are identical.
        mock_sosreport.build(large_dir, rnd_seed=20261014, journal_lines=args.large_lines, var_log_lines=max(2000, args.large_lines // 10))
        built.append(large_dir)
        if not args.no_archives:
            archive_xz(large_dir, large_dir + ".tar.xz")
            built.append(large_dir + ".tar.xz")

    copies = []
    if args.copy_to:
        dest_root = os.path.abspath(os.path.expanduser(args.copy_to))
        os.makedirs(dest_root, exist_ok=True)
        # Iterate over a snapshot: the copies are collected separately so the
        # loop never reaches (and resets) a destination it just wrote.
        for path in list(built):
            if os.path.isdir(path):
                dest = os.path.join(dest_root, os.path.basename(path))
                if os.path.realpath(dest) == os.path.realpath(path):
                    continue
                _reset(dest)
                shutil.copytree(path, dest)
                copies.append(dest)

    for path in built:
        if os.path.isfile(path):
            print(f"archive {path}  ({os.path.getsize(path) / 1024:.0f} KiB)")
        else:
            n = sum(len(f) for _, _, f in os.walk(path))
            print(f"tree    {path}  ({n} files)")
    for dest in copies:
        n = sum(len(f) for _, _, f in os.walk(dest))
        print(f"copied  {dest}  ({n} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
