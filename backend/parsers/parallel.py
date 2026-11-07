"""Run one function over many inputs in worker processes: the Diagnostics parsers' way to use more than one core
for a CPU-bound scan (the Log Collection Histogram reads its sources this way; the Log Viewer and the other
parsers can adopt it the same way).

    results = parallel.run(func, items, workers=None, cancelled=None, progress=None, info=None)
    for result in parallel.imap(func, items, workers=None, cancelled=None, info=None, ahead=None):   # streamed, in order

    func       a module-level function of an importable module (parsers.<...>), not of __main__: the workers import
               it by name. It takes one item and returns a SUMMARY (counts, a few samples), never the raw lines -
               every result travels back through a pipe and stays in memory until the run ends.
    items      a list of picklable inputs (a path, a byte range, the options); results come back in the same order,
               so a parallel run and a serial one give identical results.
    workers    None: default_workers() (JACARIUM_WORKERS, else the Settings choice, else the cores less one, at most
               MAX_WORKERS);
               1 (or a single item): serial, in this process.
    cancelled  a callable polled while the run waits (Generation.checker() makes one): when it answers True the
               workers are terminated mid-item and Cancelled is raised.
    progress   progress(done, total), after every item, in this process (the caller's thread).
    info       a dict filled in with how it ran: mode ('parallel' / 'serial'), workers, fallback (the reason a
               pool could not start: the run went serial), seconds.

How it runs: `workers` processes started with the spawn method on every platform (the macOS and Windows default,
and on Linux the same behaviour instead of 3.14's forkserver default): a fresh interpreter, no inherited sockets or
threads, nothing of the Flask app. The parent's __main__ is hidden while they start, so a child never re-imports
the backend's entry script (app.py would start the app's schedulers again); the frozen backend's children are
diverted by multiprocessing.freeze_support() at the top of app_standalone.py before anything else runs. Each worker
says it is ready; a pool that cannot start (no process support in a sandbox, a frozen-app problem, a child that
never answers within STARTUP_TIMEOUT) is torn down and the run goes serial - never an error. The items are handed
out one at a time to whichever worker is free (the caller orders them, largest first, for an even finish). The
workers are daemonic and every exit path - the end, an error, a cancel - stops, joins and, when needed, kills them:
no process outlives the run (the spawn method's own resource tracker, one small process per backend, stays for the
backend's lifetime, as Python designs it).
"""
import multiprocessing
import multiprocessing.connection
import os
import sys
import threading
import time
import traceback
import types

ENV_WORKERS = 'JACARIUM_WORKERS'
MAX_WORKERS = 8           # the default's cap: a few cores already give most of the gain, memory grows per worker
STARTUP_TIMEOUT = 30.0    # seconds for every worker to say it is ready (a frozen app on a cold disk is the slow case)
POLL = 0.1                # seconds between two looks at `cancelled` while the workers run
JOIN_TIMEOUT = 2.0

_START_LOCK = threading.Lock()   # one pool starts at a time (the hidden __main__ is process-wide)


class Cancelled(Exception):
    """The run was cancelled (the `cancelled` callable said so); the workers are gone."""


class WorkerError(RuntimeError):
    """An item failed in a worker: the exception's type and message, the worker's traceback in .details."""

    def __init__(self, message, details=''):
        super().__init__(message)
        self.details = details


# ---------------------------------------------------------------- the worker count (Settings > General > Performance)
#
# Resolved on every call, so a change applies to the next analysis or load:
#   1. JACARIUM_WORKERS in the backend's environment (an operator's override; wins, the setting cannot change it);
#   2. the stored setting (SETTINGS_FILE: {"workers": "auto" | n}, written by the Settings page through
#      backend/parallel_settings.py), n from 1 (serial) to the machine's cores;
#   3. Auto: the cores less one (the backend keeps one for its requests), at least 1, at most MAX_WORKERS - so a
#      1- or 2-core machine reads serially.
SETTINGS_ENV = 'JACARIUM_PARALLEL_SETTINGS'   # the setting file's path (the tests point it elsewhere)
_settings_cache = {'path': None, 'mtime': None, 'value': 'auto'}


def cpu_count():
    """The cores of the machine the backend runs on."""
    return os.cpu_count() or 1


def auto_workers(cores=None):
    """What Auto means on a machine with `cores` cores."""
    cores = cpu_count() if cores is None else cores
    return max(1, min(cores - 1, MAX_WORKERS))


def settings_path():
    """The setting's file: beside the backend's settings file (~/.jacarium.env: the profile's home on the desktop,
    /data in the container)."""
    raw = os.environ.get(SETTINGS_ENV)
    if raw:
        return os.path.expanduser(raw)
    home = os.environ.get('JACARIUM_PROFILE_HOME')
    return os.path.join(os.path.expanduser(home) if home else os.path.expanduser('~'), '.jacarium-workers.json')


def env_override():
    """The worker count JACARIUM_WORKERS sets (1..64), or None."""
    env = os.environ.get(ENV_WORKERS, '').strip()
    if env:
        try:
            return max(1, min(64, int(env)))
        except ValueError:
            return None
    return None


def stored_setting():
    """The stored choice: 'auto' or an int (re-read when the file changes; 'auto' without one or when unreadable)."""
    import json
    path = settings_path()
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return 'auto'
    c = _settings_cache
    if c['path'] == path and c['mtime'] == mtime:
        return c['value']
    value = 'auto'
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f).get('workers', 'auto')
        if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 1:
            value = raw
    except (OSError, ValueError, AttributeError):
        value = 'auto'
    c.update({'path': path, 'mtime': mtime, 'value': value})
    return value


def validate_setting(value, cores=None):
    """('auto' | n, None) for a valid choice, (None, error) otherwise: 'auto', or an integer from 1 to the cores."""
    cores = cpu_count() if cores is None else cores
    if value == 'auto':
        return 'auto', None
    if isinstance(value, bool) or not isinstance(value, int):
        return None, 'workers must be "auto" or a whole number'
    if value < 1 or value > cores:
        return None, f'workers must be from 1 to {cores} (the cores of this machine), or "auto"'
    return value, None


def save_setting(value):
    """Store a validated choice (atomically)."""
    import json
    path = settings_path()
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'workers': value}, f)
    os.replace(tmp, path)


def default_workers():
    """The worker count when the caller names none (see the block above): JACARIUM_WORKERS, else the stored setting
    (clamped to the cores), else Auto."""
    env = env_override()
    if env is not None:
        return env
    value = stored_setting()
    if value != 'auto':
        return max(1, min(value, cpu_count()))
    return auto_workers()


def settings_view():
    """What the Settings page shows: the cores, what Auto means, the stored choice, the count in effect, the
    environment override."""
    cores = cpu_count()
    return {'cores': cores, 'auto': auto_workers(cores), 'value': stored_setting(), 'effective': default_workers(),
            'override': env_override(), 'max': cores}


class Generation:
    """Cancellation by generation, per key (a report directory): begin(key) starts a run and returns its token; a
    newer begin(key) or cancel(key) makes every older token stale; checker(key, token) is the `cancelled` callable
    of run(). Thread-safe."""

    def __init__(self):
        self._lock = threading.Lock()
        self._gen = {}

    def begin(self, key):
        with self._lock:
            self._gen[key] = self._gen.get(key, 0) + 1
            return self._gen[key]

    def current(self, key, token):
        return self._gen.get(key) == token

    def cancel(self, key):
        self.begin(key)

    def checker(self, key, token):
        return lambda: not self.current(key, token)


# ---------------------------------------------------------------- the worker side

def _worker(conn):
    """A worker's loop: ready, then (index, func, item) -> (index, ok, result | (type, message, traceback)) until
    None or the parent is gone (EOF)."""
    try:
        conn.send(('ready', os.getpid()))
        while True:
            msg = conn.recv()
            if msg is None:
                break
            index, func, item = msg
            try:
                conn.send((index, True, func(item)))
            except BaseException as e:  # noqa: BLE001 - every failure goes back to the parent, the worker carries on
                conn.send((index, False, (type(e).__name__, str(e)[:2000], traceback.format_exc(limit=12)[-8000:])))
    except (EOFError, OSError, KeyboardInterrupt):
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


# ---------------------------------------------------------------- the parent side

class _HiddenMain:
    """While the workers start, __main__ is a bare module: spawn then has no main script to re-import in the
    child (get_preparation_data reads __main__'s __spec__ and __file__)."""

    def __enter__(self):
        self.saved = sys.modules.get('__main__')
        sys.modules['__main__'] = types.ModuleType('__main__')
        return self

    def __exit__(self, *exc):
        if self.saved is not None:
            sys.modules['__main__'] = self.saved
        return False


def _check_func(func):
    if getattr(func, '__module__', '__main__') in ('__main__', '__mp_main__') or '<' in getattr(func, '__qualname__', '<'):
        raise TypeError('parallel.run needs a module-level function of an importable module, not ' + repr(func))


def _serial(func, items, cancelled, progress):
    out = []
    total = len(items)
    for i, item in enumerate(items):
        if cancelled and cancelled():
            raise Cancelled()
        out.append(func(item))
        if progress:
            progress(i + 1, total)
    return out


def _stop(procs, conns, graceful):
    """Every worker gone: a None to each (graceful), a join, then terminate and kill what is left; the pipes closed."""
    if graceful:
        for c in conns:
            try:
                c.send(None)
            except (OSError, ValueError, BrokenPipeError):
                pass
    deadline = time.monotonic() + (JOIN_TIMEOUT if graceful else 0.2)
    for p in procs:
        p.join(max(0.0, deadline - time.monotonic()))
    for p in procs:
        if p.is_alive():
            p.terminate()
    for p in procs:
        p.join(JOIN_TIMEOUT)
        if p.is_alive():
            p.kill()
            p.join(JOIN_TIMEOUT)
    for c in conns:
        try:
            c.close()
        except OSError:
            pass
    for p in procs:
        try:
            p.close()
        except ValueError:
            pass   # still running after a kill: nothing more to do


def _start(n, startup_timeout, cancelled):
    """n workers up and ready: (procs, conns), or raise (the caller falls back to serial)."""
    ctx = multiprocessing.get_context('spawn')
    procs, conns = [], []
    try:
        with _START_LOCK, _HiddenMain():
            for i in range(n):
                parent, child = ctx.Pipe(duplex=True)
                p = ctx.Process(target=_worker, args=(child,), name=f'jacarium-worker-{i + 1}', daemon=True)
                p.start()
                child.close()
                procs.append(p)
                conns.append(parent)
        waiting = set(conns)
        deadline = time.monotonic() + startup_timeout
        while waiting:
            if cancelled and cancelled():
                raise Cancelled()
            left = deadline - time.monotonic()
            if left <= 0:
                raise RuntimeError(f'{len(waiting)} of {n} worker processes did not start within {startup_timeout:.0f} s')
            for c in multiprocessing.connection.wait(list(waiting), timeout=min(POLL, left)):
                msg = c.recv()   # EOFError: the child died before it was ready
                if not (isinstance(msg, tuple) and msg and msg[0] == 'ready'):
                    raise RuntimeError('a worker process answered something else than ready')
                waiting.discard(c)
        return procs, conns
    except BaseException:
        _stop(procs, conns, graceful=False)
        raise


def run(func, items, workers=None, cancelled=None, progress=None, info=None, startup_timeout=STARTUP_TIMEOUT):
    """See the module docstring."""
    _check_func(func)
    items = list(items)
    info = info if info is not None else {}
    t0 = time.monotonic()
    n = default_workers() if workers is None else max(1, int(workers))
    n = min(n, len(items))
    info.update({'mode': 'serial', 'workers': 1, 'fallback': None})
    if n <= 1:
        try:
            return _serial(func, items, cancelled, progress)
        finally:
            info['seconds'] = round(time.monotonic() - t0, 3)
    try:
        procs, conns = _start(n, startup_timeout, cancelled)
    except Cancelled:
        info['seconds'] = round(time.monotonic() - t0, 3)
        raise
    except BaseException as e:  # noqa: BLE001 - no pool here (a sandbox, a frozen-app problem): serial instead
        info['fallback'] = f'{type(e).__name__}: {e}'[:300]
        try:
            return _serial(func, items, cancelled, progress)
        finally:
            info['seconds'] = round(time.monotonic() - t0, 3)
    info.update({'mode': 'parallel', 'workers': n})
    results = [None] * len(items)
    total = len(items)
    pending = list(range(total))
    pending.reverse()            # pop() hands them out in the caller's order
    busy = {}
    graceful = False
    try:
        for c in conns:
            if not pending:
                break
            i = pending.pop()
            c.send((i, func, items[i]))
            busy[c] = i
        done = 0
        while busy:
            if cancelled and cancelled():
                raise Cancelled()
            for c in multiprocessing.connection.wait(list(busy), timeout=POLL):
                try:
                    index, ok, value = c.recv()
                except (EOFError, OSError) as e:
                    p = procs[conns.index(c)]
                    p.join(0.5)
                    raise WorkerError(f'a worker process ended while reading item {busy[c]} (exit code {p.exitcode})') from e
                if not ok:
                    raise WorkerError(f'{value[0]}: {value[1]}', value[2])
                results[index] = value
                done += 1
                if progress:
                    progress(done, total)
                if pending:
                    i = pending.pop()
                    c.send((i, func, items[i]))
                    busy[c] = i
                else:
                    del busy[c]
        graceful = True
        return results
    finally:
        _stop(procs, conns, graceful)
        info['seconds'] = round(time.monotonic() - t0, 3)


def imap(func, items, workers=None, cancelled=None, info=None, startup_timeout=STARTUP_TIMEOUT, ahead=None):
    """run(), streamed: a generator that yields func(item) for each item IN THE ITEMS' ORDER, each as soon as it and
    every item before it are done (a reader shows the first results while the rest are read). At most `ahead` items
    (default: twice the workers) are handed out beyond the next one to yield, so a slow consumer keeps memory flat:
    the workers wait for it. cancelled / info / startup_timeout / the serial fallback as in run(); one worker or one
    item is serial (each func(item) computed when the consumer asks for it). Closing the generator - the consumer
    stops early, a streamed request's client goes away - stops the workers at once."""
    _check_func(func)
    items = list(items)
    info = info if info is not None else {}
    t0 = time.monotonic()
    n = default_workers() if workers is None else max(1, int(workers))
    n = min(n, len(items))
    info.update({'mode': 'serial', 'workers': 1, 'fallback': None})

    def serial():
        try:
            for item in items:
                if cancelled and cancelled():
                    raise Cancelled()
                yield func(item)
        finally:
            info['seconds'] = round(time.monotonic() - t0, 3)

    if n <= 1:
        yield from serial()
        return
    try:
        procs, conns = _start(n, startup_timeout, cancelled)
    except Cancelled:
        info['seconds'] = round(time.monotonic() - t0, 3)
        raise
    except BaseException as e:  # noqa: BLE001 - no pool here: serial instead
        info['fallback'] = f'{type(e).__name__}: {e}'[:300]
        yield from serial()
        return
    info.update({'mode': 'parallel', 'workers': n})
    ahead = max(n, int(ahead) if ahead else 2 * n)
    total = len(items)
    done = {}          # index -> result, finished but not yet yielded
    busy = {}          # conn -> the index it works on
    idle = list(conns)
    next_out = 0       # the next index to yield
    next_in = 0        # the next index to hand out
    graceful = False
    try:
        while next_out < total:
            # hand out work: to every idle worker, while the window ahead of the consumer allows
            while idle and next_in < total and next_in < next_out + ahead:
                c = idle.pop()
                c.send((next_in, func, items[next_in]))
                busy[c] = next_in
                next_in += 1
            if next_out in done:
                result = done.pop(next_out)
                next_out += 1
                yield result
                continue
            if cancelled and cancelled():
                raise Cancelled()
            for c in multiprocessing.connection.wait(list(busy), timeout=POLL):
                try:
                    index, ok, value = c.recv()
                except (EOFError, OSError) as e:
                    p = procs[conns.index(c)]
                    p.join(0.5)
                    raise WorkerError(f'a worker process ended while reading item {busy[c]} (exit code {p.exitcode})') from e
                if not ok:
                    raise WorkerError(f'{value[0]}: {value[1]}', value[2])
                done[index] = value
                del busy[c]
                idle.append(c)
        graceful = True
    finally:
        _stop(procs, conns, graceful)
        info['seconds'] = round(time.monotonic() - t0, 3)


def alive_workers():
    """The worker processes of this module still alive (the tests' leak check): multiprocessing's active children
    named jacarium-worker-*."""
    return [p for p in multiprocessing.active_children() if p.name.startswith('jacarium-worker-')]
