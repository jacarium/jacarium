#!/usr/bin/env python3
"""Render the three kernel diagnostics tabs to HTML files, the way
POST /load_tab does (render_template(template, data=..., directory=...)),
so the frame test (tests/kernel-tabs-frame.test.mjs) can serve them into
the real diagnostics frame without a Flask server on :8080 (the user's
own app may hold that port).

  render.py --out DIR --fixture REPORT_DIR [--templates backend/templates]
  render.py --out DIR --empty                 (a report without kernel logs)

Writes DIR/<sub_tab>.html for kernel_stack_traces, kernel_hung_task and
kernel_oom_killer, plus DIR/tabs.json (the real tab registry, for the
sidebar). Run with the backend venv's Python (Flask).
"""
import argparse
import importlib
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
BACKEND = os.path.join(REPO, "backend")
TABS = ["kernel_stack_traces", "kernel_hung_task", "kernel_oom_killer"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--templates", default=os.path.join(BACKEND, "templates"))
    ap.add_argument("--fixture", help="the extracted sosreport directory")
    ap.add_argument("--empty", action="store_true", help="render the empty states (a report tree without kernel logs)")
    args = ap.parse_args(argv)
    if not args.fixture and not args.empty:
        ap.error("--fixture or --empty is required")

    sys.path.insert(0, BACKEND)
    from flask import Flask, render_template  # noqa: E402
    import log_viewer  # noqa: E402

    fixture = args.fixture
    if args.empty:
        fixture = tempfile.mkdtemp(prefix="kernel-tabs-empty-")
        os.makedirs(os.path.join(fixture, "sos_commands", "logs"))
        open(os.path.join(fixture, "version.txt"), "w").close()
    data = {t: importlib.import_module(f"parsers.sosreport.{t}").parse(fixture) for t in TABS}

    tabs = []
    for tab, info in log_viewer.PARSERS["sosreport"].items():
        entry = {"tab_name": tab, "icon": info.get("icon", ""), "label": info.get("label", tab), "has_sub_tabs": "sub_tabs" in info, "sub_tabs": []}
        for sub, sinfo in info.get("sub_tabs", {}).items():
            entry["sub_tabs"].append({"tab_name": sub, "icon": sinfo.get("icon", ""), "label": sinfo.get("label", sub)})
        tabs.append(entry)

    app = Flask(__name__, template_folder=os.path.abspath(args.templates))
    os.makedirs(args.out, exist_ok=True)
    with app.app_context():
        for tab in TABS:
            html = render_template(f"tabs/sosreport_{tab}.html", data=data[tab], directory=fixture)
            with open(os.path.join(args.out, f"{tab}.html"), "w") as f:
                f.write(html)
            print(f"{tab}: {len(html)} bytes")
    with open(os.path.join(args.out, "tabs.json"), "w") as f:
        json.dump(tabs, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
