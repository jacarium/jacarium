"""Settings > General > Performance: how many CPU cores the backend's parallel work uses (the Log Collection
Histogram, the Log Viewer's large logs - backend/parsers/parallel.py).

    GET /api/settings/parallel   {cores, auto, value, effective, override, max, canChange, reason}
        cores      the cores of the machine the BACKEND runs on (the desktop's own computer; the server's in a
                   container) - never the browser's
        auto       what Auto means there: the cores less one, at least 1, at most 8 (1 on a 1- or 2-core machine)
        value      the stored choice: "auto" or a number
        effective  the worker count the next analysis uses
        override   the count JACARIUM_WORKERS sets in the backend's environment (it wins), or null
        canChange  whether this user may change it, and `reason` when not
    PUT /api/settings/parallel   {"workers": "auto" | n}, n from 1 (serial) to the cores; 400 otherwise, 409 while
        JACARIUM_WORKERS sets it, 401 / 403 for a user who may not change it.

Who may change it: the desktop app and a single-user container (app-token / no auth) - the one user; on a server
with accounts, an administrator (with the step-up over a linked device, like every administrative change) - it is
the server's machine, shared by everyone; any signed-in user may read it. Stored per installation beside the
settings file (parallel.settings_path()); applies to the next analysis or load.
"""
from flask import Blueprint, jsonify, request

from user_context import accounts_mode

parallel_settings_api = Blueprint('parallel_settings_api', __name__)


def _refusal():
    """None when this request may change the setting, else the refusal response."""
    if accounts_mode():
        from auth import require_admin_action
        return require_admin_action()
    return None


def _view():
    from parsers import parallel
    view = parallel.settings_view()
    refused = _refusal()
    view['canChange'] = refused is None and view['override'] is None
    if view['override'] is not None:
        view['reason'] = 'set by JACARIUM_WORKERS in the backend\'s environment'
    elif refused is not None:
        view['reason'] = 'only an administrator of this server can change it'
    else:
        view['reason'] = None
    return view


@parallel_settings_api.route('/api/settings/parallel', methods=['GET'])
def get_parallel_settings():
    return jsonify(_view())


@parallel_settings_api.route('/api/settings/parallel', methods=['PUT'])
def put_parallel_settings():
    from parsers import parallel
    refused = _refusal()
    if refused is not None:
        return refused
    if parallel.env_override() is not None:
        return jsonify({'error': 'JACARIUM_WORKERS sets the worker count in the backend\'s environment; unset it to choose here', **_view()}), 409
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or 'workers' not in body:
        return jsonify({'error': 'expected {"workers": "auto" | a number}'}), 400
    value, error = parallel.validate_setting(body['workers'])
    if error:
        return jsonify({'error': error}), 400
    parallel.save_setting(value)
    return jsonify(_view())
