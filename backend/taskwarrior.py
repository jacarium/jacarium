"""
TaskWarrior Integration Blueprint
Provides API endpoints for TaskWarrior CLI integration
"""

from flask import Blueprint, request, jsonify
import subprocess
import json
import os
import re
import shutil
from pathlib import Path

# Where rcPath / dataPath may point (confined in the browser deployment) and
# what /instances/init may write into a taskrc - see backend/task_paths.py.
from task_paths import TaskPathError, account_defaults, resolve_data_path, resolve_rc_path, validate_taskrc_config

taskwarrior = Blueprint('taskwarrior', __name__, url_prefix='/api/taskwarrior')

def check_taskwarrior_installed():
    """Check if TaskWarrior is installed"""
    return shutil.which('task') is not None

# ---------------------------------------------------------------------------
# argv injection guard
#
# `task` parses EVERY positional argument for rc overrides (rc.name=value,
# rc:path) before deciding what the command is, so a user-supplied string in
# a positional slot - a description, an annotation, or the task id/uuid
# filter - that looks like "rc.data.location=/x" is applied as configuration
# (verified empirically: the data directory is created even when the rest of
# the command is then refused). Two defences, mirroring taskwarrior(1):
#   - free text (description / annotation) is placed after "--", which tells
#     task to treat everything that follows as literal text; attributes
#     (project:, priority:, due:, +tag) are emitted BEFORE the "--" and are
#     safe because their attr: prefix makes them attributes, never overrides;
#   - the id/uuid filter position accepts only a real UUID or a numeric id.
# ---------------------------------------------------------------------------
_TASK_ID_RE = re.compile(r'^(?:\d{1,9}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8})$')


def is_valid_task_id(value):
    """True for a numeric id, a full UUID, or an 8-hex short UUID."""
    return isinstance(value, str) and bool(_TASK_ID_RE.match(value.strip()))


def _invalid_task_id_response(value):
    """400 response tuple when `value` cannot safely be used as a task filter, else None."""
    if is_valid_task_id(value):
        return None
    return jsonify({
        'success': False,
        'error': 'Task UUID must be a numeric id or a UUID'
    }), 400


# ---------------------------------------------------------------------------
# Filter token guard (/reports/execute)
#
# A report's filter is free text the user typed ("project:Work +urgent
# status:pending"), split into argv tokens that go BEFORE the command. task
# finds its command by scanning the words for a command name - or a unique
# abbreviation of one (abbreviation.minimum, default 2) - so a bare word in
# the filter position can BECOME the command: `task execute id export`
# runs `id export` in a shell. `execute`, `edit` ($EDITOR), `import` and
# every mutating command were all reachable that way, and `rc.*=` / `rc:`
# tokens are applied as configuration (see the guard above). A filter
# token is therefore accepted only when it is unambiguously a filter:
#   - an attribute `name:value` or `name.mod:value` (the ':' means it can
#     never match a command; `rc:` and `rc.` are refused explicitly);
#   - a tag `+name` / `-name`;
#   - a numeric id, id range / list, or a UUID;
#   - a /regex/ pattern;
#   - the operators ( ) and or xor;
#   - a bare word that is NOT a prefix (2+ chars) of any task command or
#     built-in report (plain description search still works for ordinary
#     words; for others use description:word or /word/).
# Nothing starting with "--" (task's own flags) is accepted.
# ---------------------------------------------------------------------------
_TASK_COMMANDS = frozenset((
    'add', 'annotate', 'append', 'calc', 'calendar', 'colors', 'columns',
    'commands', 'config', 'context', 'count', 'delete', 'denotate',
    'diagnostics', 'done', 'duplicate', 'edit', 'execute', 'export',
    'ghistory', 'help', 'history', 'ids', 'import', 'information', 'log',
    'logo', 'modify', 'news', 'prepend', 'projects', 'purge', 'reports',
    'show', 'start', 'stats', 'stop', 'summary', 'synchronize', 'sync',
    'tags', 'timesheet', 'udas', 'undo', 'uuids', 'version', 'burndown',
    # built-in reports occupy the same slot
    'active', 'all', 'blocked', 'blocking', 'completed', 'list', 'long',
    'ls', 'minimal', 'newest', 'next', 'oldest', 'overdue', 'pending',
    'ready', 'recurring', 'unblocked', 'waiting',
))
_FILTER_ATTRIBUTE_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?:')
_FILTER_TAG_RE = re.compile(r'^[+-][A-Za-z0-9_.@-]+$')
_FILTER_IDS_RE = re.compile(r'^\d{1,9}(-\d{1,9})?(,\d{1,9}(-\d{1,9})?)*$')
_FILTER_UUID_RE = re.compile(r'^([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8})(,([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8}))*$')
_FILTER_WORD_RE = re.compile(r'^[A-Za-z0-9_.@\'-]+$')
_FILTER_OPERATORS = frozenset(('(', ')', 'and', 'or', 'xor'))
_MAX_FILTER_TOKENS = 64
_MAX_FILTER_TOKEN_LENGTH = 512


def _is_command_prefix(word):
    lowered = word.lower()
    if lowered.startswith('_'):
        return True  # helper commands (_get, _projects, ...)
    if len(lowered) < 2:
        return False
    return any(name.startswith(lowered) for name in _TASK_COMMANDS)


def validate_filter_tokens(filter_args):
    """
    Return the filter tokens safe to place before the command, or raise
    ValueError naming the offending token. Accepts a string (split on
    whitespace) or a list of strings.
    """
    if filter_args is None or filter_args == '':
        return []
    if isinstance(filter_args, str):
        tokens = filter_args.split()
    elif isinstance(filter_args, list):
        tokens = filter_args
    else:
        raise ValueError('filter must be a string or a list of strings')
    if len(tokens) > _MAX_FILTER_TOKENS:
        raise ValueError('filter has too many terms')
    safe = []
    for raw in tokens:
        if not isinstance(raw, str):
            raise ValueError('filter terms must be strings')
        raw = raw.strip()
        if not raw:
            continue
        if len(raw) > _MAX_FILTER_TOKEN_LENGTH or re.search(r'[\x00-\x1f\x7f]', raw):
            raise ValueError('filter term is too long or contains a control character')
        # "(project:Work" / "project:Home)" - parentheses glued to a term
        # are emitted as their own operator tokens.
        token = raw
        opening = 0
        while token.startswith('(') and len(token) > 1:
            token = token[1:]
            opening += 1
        closing = 0
        while token.endswith(')') and len(token) > 1:
            token = token[:-1]
            closing += 1
        safe.extend(['('] * opening)
        safe.append(_validated_filter_term(token))
        safe.extend([')'] * closing)
    return safe


def _validated_filter_term(token):
    """One filter term (no surrounding parentheses), or raise ValueError."""
    lowered = token.lower()
    if token.startswith('--') or lowered.startswith('rc.') or lowered.startswith('rc:'):
        raise ValueError(f'filter term {token!r} is not allowed')
    if lowered in _FILTER_OPERATORS:
        return lowered
    if _FILTER_ATTRIBUTE_RE.match(token):
        return token
    if _FILTER_TAG_RE.match(token) or _FILTER_IDS_RE.match(token) or _FILTER_UUID_RE.match(token):
        return token
    if len(token) >= 3 and token.startswith('/') and token.endswith('/'):
        return token
    if _FILTER_WORD_RE.match(token) and not _is_command_prefix(token):
        return token
    raise ValueError(
        f'filter term {token!r} is not allowed: it could be read as a task command. '
        'Use description:word or /word/ to search for text.')


_REPORT_NAME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_.-]{0,63}$')


# `task import` reports one line per task it touched, in the form
#   " add  <uuid> <description>"   (task was new)
#   " mod  <uuid> <description>"   (a task with that uuid existed and was overwritten)
# surrounded by chatter that depends on rc.verbose ("Importing 'STDIN'",
# "Modifying task ...", "Imported N tasks.", "TASKRC override: ..."). Verified
# against TaskWarrior 3.4.2; the same two-word prefix exists in 2.6.
_IMPORT_LINE_RE = re.compile(
    r'^\s*(add|mod)\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b'
)


def parse_import_output(output):
    """
    Per-task outcome of a `task import` run, from its stdout.

    Returns {'added': [uuid, ...], 'modified': [uuid, ...]} in output order
    (lower-cased uuids, each listed once). Lines that are not add/mod lines
    are ignored, so callers can rely on the lists no matter what rc.verbose
    setting the user's taskrc has.
    """
    added = []
    modified = []
    for line in (output or '').splitlines():
        match = _IMPORT_LINE_RE.match(line)
        if not match:
            continue
        verb, uuid = match.group(1), match.group(2).lower()
        bucket = added if verb == 'add' else modified
        if uuid not in bucket:
            bucket.append(uuid)
    return {'added': added, 'modified': modified}


def run_task_command(args, input_data=None, rc_path=None, data_path=None, plain=False):
    """
    Execute a TaskWarrior command

    Args:
        args: List of command arguments
        input_data: Optional input data to pipe to command
        rc_path: Optional path to taskrc file
        data_path: Optional path to task data directory
        plain: run `task` with no rc / data overrides at all (``task
            --version``: with an override in front, task reads --version as
            a filter and answers "No matches")

    Returns:
        dict: {success, output, error}
    """
    try:
        if not check_taskwarrior_installed():
            return {
                'success': False,
                'error': 'TaskWarrior is not installed. Please install it using: sudo apt install taskwarrior (Ubuntu/Debian) or brew install task (macOS)'
            }

        # Build command with optional rc and data overrides. Every route
        # funnels its client-supplied paths through here, so this is where
        # the browser deployment's confinement applies (task_paths.py).
        cmd = ['task']

        try:
            rc_path = resolve_rc_path(rc_path)
            data_path = resolve_data_path(data_path)
            rc_path, data_path = account_defaults(rc_path, data_path)
        except TaskPathError as e:
            return {'success': False, 'error': str(e)}
        if plain:
            rc_path = data_path = None

        if rc_path:
            cmd.extend(['rc:' + rc_path])

        if data_path:
            cmd.extend(['rc.data.location=' + data_path])

        cmd.extend(args)

        # Set up environment
        env = os.environ.copy()

        # Execute command
        if input_data:
            result = subprocess.run(
                cmd,
                input=input_data,
                capture_output=True,
                text=True,
                timeout=30,
                env=env
            )
        else:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
                env=env
            )

        if result.returncode == 0:
            return {
                'success': True,
                'output': result.stdout,
                'error': result.stderr if result.stderr else None
            }
        else:
            return {
                'success': False,
                'output': result.stdout,
                'error': result.stderr or f'Command exited with code {result.returncode}'
            }

    except subprocess.TimeoutExpired:
        return {
            'success': False,
            'error': 'Command timed out after 30 seconds'
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }

@taskwarrior.route('/check', methods=['GET'])
def check_installation():
    """Check if TaskWarrior is installed"""
    installed = check_taskwarrior_installed()

    if installed:
        # Get version
        result = run_task_command(['--version'], plain=True)
        version = result.get('output', '').strip() if result.get('success') else 'unknown'

        return jsonify({
            'installed': True,
            'version': version
        })
    else:
        return jsonify({
            'installed': False,
            'message': 'TaskWarrior is not installed'
        })

@taskwarrior.route('/export', methods=['GET', 'POST'])
def export_tasks():
    """Export all tasks from TaskWarrior in JSON format"""
    try:
        # Get filter parameters from query string or JSON body
        if request.method == 'POST':
            data = request.get_json() or {}
            status = data.get('status', None)
            project = data.get('project', None)
            tags = data.get('tags', None)
            rc_path = data.get('rcPath', None)
            data_path = data.get('dataPath', None)
        else:
            status = request.args.get('status', None)
            project = request.args.get('project', None)
            tags = request.args.get('tags', None)
            rc_path = request.args.get('rcPath', None)
            data_path = request.args.get('dataPath', None)

        # Build filter
        filter_args = []

        # Override default export filter to include ALL statuses (pending, completed, deleted, waiting)
        # unless a specific status is requested
        if not status:
            filter_args.append('rc.report.export.filter=status.any:')
        else:
            filter_args.append(f'status:{status}')

        if project:
            filter_args.append(f'project:{project}')
        if tags:
            # Tags can be comma-separated
            tag_list = tags.split(',') if isinstance(tags, str) else tags
            for tag in tag_list:
                filter_args.append(f'+{tag.strip()}')

        # Execute export command
        args = filter_args + ['export']
        result = run_task_command(args, rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        # Parse JSON output
        try:
            tasks = json.loads(result['output']) if result['output'].strip() else []
            return jsonify(tasks)
        except json.JSONDecodeError as e:
            return jsonify({
                'success': False,
                'error': f'Failed to parse TaskWarrior output: {str(e)}'
            }), 500

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/import', methods=['POST'])
def import_tasks():
    """Import tasks to TaskWarrior from JSON"""
    try:
        data = request.get_json()
        tasks = data.get('tasks', [])
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        # If no tasks, return success with count 0
        if not tasks:
            return jsonify({
                'success': True,
                'count': 0,
                'message': 'No tasks to import'
            })

        # Convert tasks to JSON and import
        tasks_json = json.dumps(tasks)

        result = run_task_command(['import'], input_data=tasks_json, rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        outcomes = parse_import_output(result['output'])

        return jsonify({
            'success': True,
            'count': len(tasks),
            'added': outcomes['added'],
            'modified': outcomes['modified'],
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/add', methods=['POST'])
def add_task():
    """Add a new task to TaskWarrior"""
    try:
        data = request.get_json()
        description = data.get('description', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not description:
            return jsonify({
                'success': False,
                'error': 'Task description is required'
            }), 400

        # Build command arguments
        # Attributes first, then "--", then the description as literal text
        # (see the argv injection guard above run_task_command)
        args = ['add']

        # Add optional attributes
        if data.get('project'):
            args.append(f'project:{data["project"]}')

        if data.get('priority'):
            args.append(f'priority:{data["priority"]}')

        if data.get('due'):
            args.append(f'due:{data["due"]}')

        if data.get('tags'):
            for tag in data['tags']:
                args.append(f'+{tag}')

        args.extend(['--', description])

        result = run_task_command(args, rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/modify', methods=['POST'])
def modify_task():
    """Modify an existing task in TaskWarrior"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        # Build command arguments
        args = [uuid, 'modify']

        # Add modifications
        if data.get('description'):
            args.append(f'description:{data["description"]}')

        if data.get('project') is not None:
            args.append(f'project:{data["project"]}')

        if data.get('priority') is not None:
            args.append(f'priority:{data["priority"]}')

        if data.get('status'):
            # Status change is done via different commands
            if data['status'] == 'completed':
                args = [uuid, 'done']
            elif data['status'] == 'deleted':
                # Without rc.confirmation=off, 'delete' prompts "Delete task N?
                # (yes/no)" on stdin; run_task_command never sets stdin, so the
                # prompt hits EOF, TaskWarrior aborts, and the task silently
                # stays pending despite the route reporting success.
                args = ['rc.confirmation=off', uuid, 'delete']

        result = run_task_command(args, rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/done', methods=['POST'])
def mark_done():
    """Mark a task as completed"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        result = run_task_command([uuid, 'done'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/start', methods=['POST'])
def start_task():
    """Start a task (begin time tracking)"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        result = run_task_command([uuid, 'start'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/stop', methods=['POST'])
def stop_task():
    """Stop a task (pause time tracking)"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        result = run_task_command([uuid, 'stop'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/annotate', methods=['POST'])
def annotate_task():
    """Add an annotation (note) to a task"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        annotation = data.get('annotation', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        if not annotation:
            return jsonify({
                'success': False,
                'error': 'Annotation text is required'
            }), 400

        # "--" makes the annotation literal text (never an rc override)
        result = run_task_command([uuid, 'annotate', '--', annotation], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result.get('error', 'Unknown error')
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/denotate', methods=['POST'])
def denotate_task():
    """Remove an annotation (note) from a task"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        annotation = data.get('annotation', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        if not annotation:
            return jsonify({
                'success': False,
                'error': 'Annotation text is required'
            }), 400

        # Use rc.confirmation=off to bypass confirmation
        result = run_task_command(['rc.confirmation=off', uuid, 'denotate', '--', annotation], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result.get('error', 'Unknown error')
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/delete', methods=['POST'])
def delete_task():
    """Delete a task"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        # Use rc.confirmation=off to bypass confirmation prompt
        result = run_task_command(['rc.confirmation=off', uuid, 'delete'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            error_msg = result.get('error', '')
            output_msg = result.get('output', '')
            print(f"[TaskWarrior Delete] Failed to delete task {uuid}: {error_msg}")
            print(f"[TaskWarrior Delete] Output: {output_msg}")

            # If task doesn't exist or is already deleted, treat as success
            if ('No matches' in error_msg or 'not found' in error_msg.lower() or
                'not deletable' in output_msg.lower() or 'Deleted 0 tasks' in output_msg):
                print(f"[TaskWarrior Delete] Task {uuid} already deleted or doesn't exist, treating as success")
                return jsonify({
                    'success': True,
                    'output': 'Task already deleted or does not exist'
                })

            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        print(f"[TaskWarrior Delete] Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/purge', methods=['POST'])
def purge_task():
    """Permanently purge a task (for already-deleted tasks)"""
    try:
        data = request.get_json()
        uuid = data.get('uuid', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not uuid:
            return jsonify({
                'success': False,
                'error': 'Task UUID is required'
            }), 400
        invalid_id = _invalid_task_id_response(uuid)
        if invalid_id:
            return invalid_id
        uuid = uuid.strip()

        # Use rc.confirmation=off to bypass confirmation prompt
        result = run_task_command(['rc.confirmation=off', uuid, 'purge'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            error_msg = result.get('error', '')
            print(f"[TaskWarrior Purge] Failed to purge task {uuid}: {error_msg}")

            # If task doesn't exist, treat as success (already purged)
            if 'No matches' in error_msg or 'not found' in error_msg.lower():
                print(f"[TaskWarrior Purge] Task {uuid} doesn't exist, treating as success")
                return jsonify({
                    'success': True,
                    'output': 'Task already purged or does not exist'
                })

            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        return jsonify({
            'success': True,
            'output': result['output']
        })

    except Exception as e:
        print(f"[TaskWarrior Purge] Exception: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# There is deliberately no "run any task command" route. The former
# POST /command split a client string into argv and ran it, i.e. `task
# execute <anything>` (a shell command) for whoever could reach the
# backend - in the browser deployment that is everyone on the network. No
# part of the app called it; every operation the UI needs has its own
# route above with validated arguments.

@taskwarrior.route('/projects', methods=['GET', 'POST'])
def get_projects():
    """Get list of all projects"""
    try:
        # Get optional instance configuration
        if request.method == 'POST':
            data = request.get_json() or {}
            rc_path = data.get('rcPath', None)
            data_path = data.get('dataPath', None)
        else:
            rc_path = request.args.get('rcPath', None)
            data_path = request.args.get('dataPath', None)

        result = run_task_command(['_projects'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        # Parse output - one project per line
        projects = [p.strip() for p in result['output'].split('\n') if p.strip()]

        return jsonify({
            'success': True,
            'projects': projects
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/tags', methods=['GET', 'POST'])
def get_tags():
    """Get list of all tags"""
    try:
        # Get optional instance configuration
        if request.method == 'POST':
            data = request.get_json() or {}
            rc_path = data.get('rcPath', None)
            data_path = data.get('dataPath', None)
        else:
            rc_path = request.args.get('rcPath', None)
            data_path = request.args.get('dataPath', None)

        result = run_task_command(['_tags'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        # Parse output - one tag per line
        tags = [t.strip() for t in result['output'].split('\n') if t.strip()]

        return jsonify({
            'success': True,
            'tags': tags
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/reports', methods=['GET', 'POST'])
def get_reports():
    """Get list of available TaskWarrior reports"""
    try:
        # Get optional instance configuration
        if request.method == 'POST':
            data = request.get_json() or {}
            rc_path = data.get('rcPath', None)
            data_path = data.get('dataPath', None)
        else:
            rc_path = request.args.get('rcPath', None)
            data_path = request.args.get('dataPath', None)

        # Get show output which lists all reports
        result = run_task_command(['show'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        # Parse reports from output
        reports = []
        lines = result['output'].split('\n')

        for line in lines:
            line = line.strip()
            # Look for report definitions (report.NAME.columns, report.NAME.description, etc.)
            if line.startswith('report.') and '.columns' in line:
                # Extract report name
                parts = line.split('.')
                if len(parts) >= 3:
                    report_name = parts[1]
                    if report_name not in [r['name'] for r in reports]:
                        reports.append({
                            'name': report_name,
                            'isBuiltIn': True
                        })

        # Add common built-in reports if not found
        common_reports = ['list', 'next', 'completed', 'pending', 'active', 'all', 'recurring', 'waiting']
        for report_name in common_reports:
            if report_name not in [r['name'] for r in reports]:
                reports.append({
                    'name': report_name,
                    'isBuiltIn': True
                })

        return jsonify({
            'success': True,
            'reports': reports
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/reports/execute', methods=['POST'])
def execute_report():
    """Execute a TaskWarrior report"""
    try:
        data = request.get_json() or {}
        report_name = data.get('reportName') or 'list'
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)
        filter_args = data.get('filter', [])
        output_format = data.get('format', 'json')

        # Only the JSON form exists: the filter goes before `export` and the
        # report name is mapped to a status filter - it never reaches argv.
        # The former text form put the report name in the command slot
        # (any task command, `execute` included), which the app never used.
        if output_format != 'json':
            return jsonify({
                'success': False,
                'error': 'Only format "json" is supported'
            }), 400
        if not isinstance(report_name, str) or not _REPORT_NAME_RE.match(report_name):
            return jsonify({
                'success': False,
                'error': 'Invalid report name'
            }), 400

        # The filter is free text the user typed: only unambiguous filter
        # terms may precede the command (see validate_filter_tokens above).
        try:
            args = validate_filter_tokens(filter_args)
        except ValueError as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 400

        has_status = any(token.lower().startswith('status') and ':' in token for token in args)

        # Map common report names to filters
        if report_name == 'next':
            # Next report shows pending tasks sorted by urgency
            if not has_status:
                args.append('status:pending')
        elif report_name == 'completed':
            args.append('status:completed')
        elif report_name == 'waiting':
            args.append('status:waiting')
        elif report_name == 'all':
            pass  # No filter, show all tasks
        # For 'list' or other reports, default to pending
        elif report_name == 'list':
            if not has_status:
                args.append('status:pending')

        args.append('export')

        result = run_task_command(args, rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        try:
            tasks = json.loads(result['output']) if result['output'].strip() else []
            return jsonify({
                'success': True,
                'tasks': tasks,
                'count': len(tasks)
            })
        except json.JSONDecodeError as e:
            return jsonify({
                'success': False,
                'error': f'Failed to parse JSON output: {str(e)}'
            }), 500

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/reports/config', methods=['POST'])
def get_report_config():
    """Get configuration for a specific report"""
    try:
        data = request.get_json()
        report_name = data.get('reportName', '')
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        if not report_name:
            return jsonify({
                'success': False,
                'error': 'Report name is required'
            }), 400
        if not isinstance(report_name, str) or not _REPORT_NAME_RE.match(report_name):
            return jsonify({
                'success': False,
                'error': 'Invalid report name'
            }), 400

        # Get show output for this specific report
        result = run_task_command(['show', f'report.{report_name}'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        # Parse report configuration
        config = {
            'name': report_name,
            'columns': None,
            'labels': None,
            'sort': None,
            'filter': None,
            'description': None
        }

        lines = result['output'].split('\n')
        for line in lines:
            line = line.strip()
            if not line or line.startswith('#'):
                continue

            # Parse configuration lines
            if '=' in line:
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip()

                if f'report.{report_name}.columns' in key:
                    config['columns'] = value
                elif f'report.{report_name}.labels' in key:
                    config['labels'] = value
                elif f'report.{report_name}.sort' in key:
                    config['sort'] = value
                elif f'report.{report_name}.filter' in key:
                    config['filter'] = value
                elif f'report.{report_name}.description' in key:
                    config['description'] = value

        return jsonify({
            'success': True,
            'config': config
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# Instance Management Endpoints

@taskwarrior.route('/instances/init', methods=['POST'])
def initialize_instance():
    """Initialize a new TaskWarrior instance with custom rc and data paths"""
    try:
        data = request.get_json()
        data_path = data.get('dataPath', '')
        rc_path = data.get('rcPath', '')
        config = data.get('config', {})

        if not data_path:
            return jsonify({
                'success': False,
                'error': 'Data path is required'
            }), 400

        # Where the paths may point (confined in the browser deployment)
        # and what the taskrc may contain - backend/task_paths.py.
        try:
            data_path = resolve_data_path(data_path)
            rc_path = resolve_rc_path(rc_path)
            config_pairs = validate_taskrc_config(config)
        except TaskPathError as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 400

        # Create data directory if it doesn't exist
        data_dir = Path(data_path)
        try:
            data_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'Failed to create data directory: {str(e)}'
            }), 500

        # Create the taskrc when it does not exist yet. An existing one is
        # left as it is: initialising is idempotent, an instance that already
        # has its configuration and data keeps both (the follower calls this
        # for an instance that arrived from another device).
        if rc_path and Path(rc_path).exists():
            rc_path_existing = True
        else:
            rc_path_existing = False
        if rc_path and not rc_path_existing:
            rc_file = Path(rc_path)
            try:
                # Create parent directory if needed
                rc_file.parent.mkdir(parents=True, exist_ok=True)

                # Build taskrc content
                lines = []
                lines.append('# TaskWarrior Configuration')
                lines.append(f'data.location={data_path}')
                lines.append('')

                # Add custom configuration (validated: allow-listed key
                # syntax, no data.location/include/hooks/editor/alias...)
                config_keys = set()
                for key, value in config_pairs:
                    config_keys.add(key)
                    lines.append(f'{key}={value}')

                # Add default configurations if not provided
                if 'color' not in config_keys:
                    lines.append('color=on')
                if 'dateformat' not in config_keys:
                    lines.append('dateformat=Y-M-D H:N')

                # Write to file
                rc_file.write_text('\n'.join(lines) + '\n')

            except Exception as e:
                return jsonify({
                    'success': False,
                    'error': f'Failed to create taskrc file: {str(e)}'
                }), 500

        # Test the instance by running a simple command
        result = run_task_command(['version'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': f'Failed to initialize instance: {result["error"]}'
            }), 500

        return jsonify({
            'success': True,
            'dataPath': str(data_path),
            'rcPath': str(rc_path) if rc_path else None,
            'rcExisted': rc_path_existing,
            'message': 'TaskWarrior instance initialized successfully'
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/instances/validate', methods=['POST'])
def validate_instance():
    """Validate a TaskWarrior instance configuration"""
    try:
        data = request.get_json()
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        errors = []
        warnings = []

        try:
            rc_path = resolve_rc_path(rc_path)
            data_path = resolve_data_path(data_path)
        except TaskPathError as e:
            return jsonify({
                'success': False,
                'valid': False,
                'errors': [str(e)],
                'warnings': [],
                'stats': None
            }), 400

        # Check if paths exist
        if rc_path:
            if not os.path.exists(rc_path):
                errors.append(f'RC file does not exist: {rc_path}')
            elif not os.path.isfile(rc_path):
                errors.append(f'RC path is not a file: {rc_path}')

        if data_path:
            if not os.path.exists(data_path):
                warnings.append(f'Data directory does not exist: {data_path}')
            elif not os.path.isdir(data_path):
                errors.append(f'Data path is not a directory: {data_path}')

        # Try to run a simple command
        result = run_task_command(['version'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            errors.append(f'Failed to run TaskWarrior command: {result["error"]}')

        # Get task count statistics if valid
        stats = None
        if not errors:
            export_result = run_task_command(['export'], rc_path=rc_path, data_path=data_path)
            if export_result['success']:
                try:
                    tasks = json.loads(export_result['output']) if export_result['output'].strip() else []
                    stats = {
                        'total': len(tasks),
                        'pending': len([t for t in tasks if t.get('status') == 'pending']),
                        'completed': len([t for t in tasks if t.get('status') == 'completed']),
                        'deleted': len([t for t in tasks if t.get('status') == 'deleted']),
                    }
                except:
                    pass

        return jsonify({
            'success': len(errors) == 0,
            'valid': len(errors) == 0,
            'errors': errors,
            'warnings': warnings,
            'stats': stats
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/purge-deleted', methods=['POST'])
def purge_deleted_tasks():
    """Permanently remove all deleted tasks from TaskWarrior database"""
    try:
        data = request.get_json()
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        # Step 1: Export all non-deleted tasks
        export_result = run_task_command(['status.not:deleted', 'export'], rc_path=rc_path, data_path=data_path)

        if not export_result['success']:
            return jsonify({
                'success': False,
                'error': f"Failed to export tasks: {export_result['error']}"
            }), 500

        # Parse exported tasks
        try:
            active_tasks = json.loads(export_result['output']) if export_result['output'].strip() else []
        except json.JSONDecodeError as e:
            return jsonify({
                'success': False,
                'error': f'Failed to parse exported tasks: {str(e)}'
            }), 500

        # Step 2: Get count of deleted tasks before purging
        count_result = run_task_command(['status:deleted', 'count'], rc_path=rc_path, data_path=data_path)
        deleted_count = 0
        if count_result['success']:
            try:
                deleted_count = int(count_result['output'].strip())
            except ValueError:
                deleted_count = 0

        # Step 3: Permanently delete all deleted tasks
        if deleted_count > 0:
            # Get UUIDs of deleted tasks
            deleted_export = run_task_command(['status:deleted', 'export'], rc_path=rc_path, data_path=data_path)
            if deleted_export['success']:
                try:
                    deleted_tasks = json.loads(deleted_export['output']) if deleted_export['output'].strip() else []

                    # Permanently remove every already-deleted task in a single
                    # invocation. TaskWarrior ORs together multiple IDs/UUIDs in
                    # the filter, so one command handles every UUID at once.
                    # The verb must be 'purge', not 'delete': 'delete' only
                    # transitions a task *to* status=deleted and reports
                    # "is not deletable" for tasks that are already deleted.
                    # This matches the single-task /purge route above.
                    uuids = [task.get('uuid') for task in deleted_tasks if task.get('uuid')]
                    if uuids:
                        # rc.confirmation=off bypasses the per-task prompt, and
                        # rc.bulk=0 disables the separate "bulk change" prompt that
                        # TaskWarrior forces once a single command touches >= `bulk`
                        # (default 3) tasks - taskrc(5): that one fires "regardless of
                        # the value of confirmation variable", so batching needs both
                        # or the command stalls on stdin and purges nothing.
                        run_task_command(
                            ['rc.confirmation=off', 'rc.bulk=0'] + uuids + ['purge'],
                            rc_path=rc_path, data_path=data_path
                        )

                except json.JSONDecodeError:
                    pass

        return jsonify({
            'success': True,
            'purged_count': deleted_count,
            'remaining_tasks': len(active_tasks),
            'message': f'Purged {deleted_count} deleted tasks'
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@taskwarrior.route('/instances/stats', methods=['POST'])
def get_instance_stats():
    """Get statistics for a TaskWarrior instance"""
    try:
        data = request.get_json()
        rc_path = data.get('rcPath', None)
        data_path = data.get('dataPath', None)

        # Export all tasks
        result = run_task_command(['export'], rc_path=rc_path, data_path=data_path)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result['error']
            }), 500

        # Parse and analyze tasks
        try:
            tasks = json.loads(result['output']) if result['output'].strip() else []

            stats = {
                'total': len(tasks),
                'pending': len([t for t in tasks if t.get('status') == 'pending']),
                'completed': len([t for t in tasks if t.get('status') == 'completed']),
                'deleted': len([t for t in tasks if t.get('status') == 'deleted']),
                'waiting': len([t for t in tasks if t.get('status') == 'waiting']),
                'recurring': len([t for t in tasks if t.get('status') == 'recurring']),
            }

            # Get unique projects and tags
            projects = set()
            tags = set()
            priorities = {}

            for task in tasks:
                if task.get('project'):
                    projects.add(task['project'])
                if task.get('tags'):
                    for tag in task['tags']:
                        tags.add(tag)
                priority = task.get('priority', 'none')
                priorities[priority] = priorities.get(priority, 0) + 1

            stats['projects'] = len(projects)
            stats['tags'] = len(tags)
            stats['priorities'] = priorities

            return jsonify({
                'success': True,
                'stats': stats
            })

        except json.JSONDecodeError as e:
            return jsonify({
                'success': False,
                'error': f'Failed to parse TaskWarrior output: {str(e)}'
            }), 500

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
