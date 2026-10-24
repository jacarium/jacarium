#!/usr/bin/env python3
"""A small synthetic must-gather whose audit logs hold TWO capture windows
a day apart (a lab powered off and started again), for the broken-axis
checks of the Audit charts, with a chosen audit profile (Default by
default: no request bodies, so the Events body filters are greyed out);
--single writes one window only (a plain fixture with that profile):
  backend/venv/bin/python tests/helpers/audit-gap-fixture.py --out <dir> [--profile Default|WriteRequestBodies|Mixed]
Writes <dir>/must-gather.local.gap/<image dir>/{namespaces, audit_logs/...}
and prints the must-gather directory.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "tests", "fixtures", "diagnostics-mock"))

NAME = "must-gather.local.gap"
IMAGE = "quay-io-openshift-release-dev-ocp-v4-0-art-dev-sha256-" + "0c" * 32


class Tree:
    def __init__(self, base):
        self.base = base

    def write_bytes(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--profile", default="Default")
    ap.add_argument("--hours", type=int, default=24, help="the hole between the two windows")
    ap.add_argument("--minutes", type=int, default=120, help="the second window's length (the first is ~2 h)")
    ap.add_argument("--per-master", type=int, default=200)
    ap.add_argument("--single", action="store_true", help="one capture window only (a plain fixture with the chosen profile)")
    args = ap.parse_args(argv)
    import mock_audit_logs  # noqa: E402
    root = os.path.join(args.out, NAME)
    base = os.path.join(root, IMAGE)
    os.makedirs(os.path.join(base, "namespaces"), exist_ok=True)
    mock_audit_logs.write(Tree(base), profile=args.profile, extra_window=None if args.single else (args.hours, args.minutes, args.per_master))
    print(root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
