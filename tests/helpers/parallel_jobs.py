"""Work items for tests/parallel.test.py: module-level functions a spawned worker process imports by name
(backend/parsers/parallel.py runs them)."""
import os
import time


def square(x):
    return {'x': x, 'square': x * x, 'pid': os.getpid()}


def slow(x):
    time.sleep(x)
    return x


def boom(x):
    if x == 3:
        raise ValueError(f'item {x} is bad')
    return x


def die(x):
    if x == 2:
        os._exit(3)   # a worker that dies mid-item (an OOM kill, a crash)
    return x


def summary(n):
    """A summary of n 'lines': counts per key, as a parser returns - never the lines."""
    counts = {}
    for i in range(n):
        k = f'key-{i % 50}'
        counts[k] = counts.get(k, 0) + 1
    return counts


def mark(item):
    """Write a marker file as the item starts (the imap window test counts them), then return the index."""
    directory, index = item
    with open(os.path.join(directory, f'started-{index}'), 'w') as f:
        f.write('x')
    time.sleep(0.05)
    return index
