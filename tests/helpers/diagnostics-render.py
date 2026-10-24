#!/usr/bin/env python3
"""Render sosreport diagnostics tabs to HTML files, the way POST /load_tab
does (render_template(template, data=..., directory=...)), so a browser
test can serve them into the real diagnostics frame without a Flask server
on :8080 (the user's own app may hold that port).

  diagnostics-render.py --out DIR --fixture REPORT_DIR --tabs sos_report blame log_collection
  diagnostics-render.py --out DIR --fixture MG_DIR --report-type mustgather --tabs log_collection

Each tab is a key of the registry (a group or a sub-tab id;
sub-tabs are resolved to their group like /load_tab does). Writes
DIR/<tab>.html per tab and DIR/tabs.json (the registry, for the sidebar).
Run with the backend venv's Python (Flask).
"""
import argparse
import importlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
BACKEND = os.path.join(REPO, "backend")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fixture", required=True, help="the extracted sosreport directory")
    ap.add_argument("--tabs", nargs="+", required=True, help="registry keys (groups or sub-tab ids)")
    ap.add_argument("--templates", default=os.path.join(BACKEND, "templates"))
    ap.add_argument("--report-type", default="sosreport", choices=["sosreport", "mustgather"])
    args = ap.parse_args(argv)

    sys.path.insert(0, BACKEND)
    from flask import Flask, render_template  # noqa: E402
    import log_viewer  # noqa: E402

    registry = log_viewer.PARSERS[args.report_type]
    tabs = []
    for tab, info in registry.items():
        entry = {"tab_name": tab, "icon": info.get("icon", ""), "label": info.get("label", tab), "has_sub_tabs": "sub_tabs" in info, "sub_tabs": []}
        for sub, sinfo in info.get("sub_tabs", {}).items():
            entry["sub_tabs"].append({"tab_name": sub, "icon": sinfo.get("icon", ""), "label": sinfo.get("label", sub)})
        tabs.append(entry)

    app = Flask(__name__, template_folder=os.path.abspath(args.templates))
    os.makedirs(args.out, exist_ok=True)
    with app.app_context():
        for tab in args.tabs:
            group, sub = log_viewer._resolve_tab(args.report_type, tab, None)
            module_path = registry[group]["sub_tabs"][sub]["module"] if sub else registry[group]["module"]
            module = importlib.import_module(module_path)
            data = module.parse(args.fixture)
            findings = module.findings(args.fixture) if hasattr(module, 'findings') else (data.get('findings', []) if isinstance(data, dict) else [])
            html = render_template(f"tabs/{args.report_type}_{sub or group}.html", data=data, directory=args.fixture, findings=findings)
            with open(os.path.join(args.out, f"{tab}.html"), "w") as f:
                f.write(html)
            print(f"{tab}: {len(html)} bytes")
    with open(os.path.join(args.out, "tabs.json"), "w") as f:
        json.dump(tabs, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
