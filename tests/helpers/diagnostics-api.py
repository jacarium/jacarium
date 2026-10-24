#!/usr/bin/env python3
"""Answer one backend JSON route through the Flask test client, for the
frame tests that fake localhost:8080 with playwright routes (the Audit
Events search needs the real search over the synthetic must-gather, not
a canned answer):
  backend/venv/bin/python tests/helpers/diagnostics-api.py --path /audit_events_search --body-file req.json
prints {"status": <http status>, "json": <the answer>}; the body file holds
the request JSON (its "directory" is used as sent).
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
BACKEND = os.path.join(REPO, "backend")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--path", required=True)
    ap.add_argument("--body-file", required=True)
    args = ap.parse_args(argv)
    sys.path.insert(0, BACKEND)
    from flask import Flask  # noqa: E402
    import log_viewer  # noqa: E402
    with open(args.body_file, encoding="utf-8") as f:
        body = json.load(f)
    app = Flask(__name__, template_folder=os.path.join(BACKEND, "templates"))
    app.register_blueprint(log_viewer.log_viewer)
    app.secret_key = "diagnostics-api-helper"
    res = app.test_client().post(args.path, json=body)
    sys.stdout.write(json.dumps({"status": res.status_code, "json": res.get_json()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
