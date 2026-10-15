#!/usr/bin/env python3
"""
Guards against shell command injection in the SSH AI chat provider.

backend/ai_chat.py's handle_ssh_chat() builds ONE remote shell command from a
user-customizable template (commandInitial/commandFollowup) containing a
{{MESSAGE}} placeholder, and runs it over paramiko's exec_command() - which
only accepts a single command string, no argv-style exec.

THE BUG (fixed): the message used to be spliced into the template after
escaping only for a SINGLE-quote context, while the default templates embed
{{MESSAGE}} inside DOUBLE quotes. That mismatch meant a chat message
containing $(...), backticks or $VARs - e.g. a pasted log/command excerpt,
the normal SRE use case - was EXPANDED and EXECUTED on the SSH host, and a
double quote broke the command outright.

THE FIX under test: render_ssh_ai_command() never splices the raw message
into the shell string at all. It base64-encodes the message and expands
{{MESSAGE}} to "$(printf %s <base64> | base64 -d)". base64 output is
[A-Za-z0-9+/=] only - inert in every POSIX quoting context - so no message
character reaches the remote shell parser, regardless of whether the template
quotes {{MESSAGE}} with double quotes, single quotes, or not at all.

What this test proves (no framework, real /bin/sh):
  - a message combining $(...), backticks, ", ' and $VAR, rendered through
    double-quoted / single-quoted / bare {{MESSAGE}} templates, executes NO
    injected content (a canary file is never created) and delivers the
    message to the remote program BYTE-FOR-BYTE;
  - statically, handle_ssh_chat no longer contains the old single-quote
    escape splice (regression tripwire).

Run:  backend/venv/bin/python tests/ssh_ai_chat_injection.test.py
      (or any python3 that can import the backend module: flask, paramiko, ...)
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

from ai_chat import render_ssh_ai_command  # noqa: E402

failures = 0


def check(name, ok, detail=''):
    global failures
    status = 'PASS' if ok else 'FAIL'
    print(f"{status} - {name}" + (f" ({detail})" if detail else ''))
    if not ok:
        failures += 1


# A message packed with every shell-dangerous construct at once.
CANARY = tempfile.mktemp(prefix='ssh-ai-inj-canary-')
MESSAGE = (
    "hello $(touch {c}) `touch {c}` $HOME "
    "\"double\" 'single' end && echo pwned; rm -rf /nope"
).format(c=CANARY)

TEMPLATES = {
    'double-quoted (default style)': 'printf %s "{{MESSAGE}}"',
    'single-quoted': "printf %s '{{MESSAGE}}'",
    'bare/unquoted': 'printf %s {{MESSAGE}}',
}

for name, template in TEMPLATES.items():
    rendered = render_ssh_ai_command(template, MESSAGE)
    # Execute in a real POSIX shell and capture what the remote program (here
    # `printf %s`) would actually receive as its single argument.
    proc = subprocess.run(['/bin/sh', '-c', rendered], capture_output=True, text=True)
    injected = os.path.exists(CANARY)
    if injected:
        os.remove(CANARY)
    check(f"[{name}] injected command did NOT execute", not injected,
          'canary created' if injected else 'no canary')
    check(f"[{name}] message preserved byte-for-byte", proc.stdout == MESSAGE,
          '' if proc.stdout == MESSAGE else f"got {proc.stdout!r}")

# Static tripwire: the old single-quote escape splice must be gone.
with open(os.path.join(BACKEND, 'ai_chat.py'), 'r', encoding='utf-8') as fh:
    source = fh.read()
old_splice = re.search(r"user_message\.replace\(\s*\"'\"", source)
check("old single-quote escape splice removed from ai_chat.py", old_splice is None)
check("render_ssh_ai_command is used to build the remote command",
      'render_ssh_ai_command(' in source)

print()
if failures == 0:
    print("RESULT: all checks passed - no injection, message intact")
    sys.exit(0)
print(f"RESULT: {failures} check(s) FAILED")
sys.exit(1)
