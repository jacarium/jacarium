#!/usr/bin/env python3
"""
Guards the LanceDB filter-string injection fix (backend/doc_ids.py,
backend/vector_db.py, backend/rag_chat.py).

THE BUG: vector_db.py builds every LanceDB filter as a string -
`.where(f"doc_id = {doc_id}")`, `.delete(f"doc_id = {doc_id}")`,
`" OR ".join(f"doc_id = {id}" for id in dataset_ids)` - and rag_chat.py
passed the request's `id` / `dataset_ids` values straight in. A string such
as `1 OR 1 = 1` widened a search to every indexed document, and
`1) OR (1 = 1` / other query-language fragments reached the engine verbatim.

THE FIX: doc_ids.validate_doc_id / validate_doc_ids coerce ids to int
(integers or integer-looking strings only; bools, floats, fragments, nested
structures rejected) and are applied inside vector_db (index / search /
delete) AND at the four request entry points in rag_chat, which answer 400.

What this test proves:
  Part A: validator accept/reject matrix incl. every injection shape.
  Part B (Flask test client, no LanceDB touched): /api/rag/search and
    /api/rag/index reject injected ids with 400 before the vector store is
    ever instantiated; valid ids pass validation (and only then reach the
    store - stubbed here).
  Part C: VectorDBManager.search()/delete_document() validate even when no
    table exists (search with a bad id raises before returning []).

Self-contained, no test framework: run with the backend venv interpreter.

  backend/venv/bin/python tests/rag_doc_id_validation.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)
os.environ.setdefault('APP_AUTH_TOKEN', 'test-token')

try:
    import flask  # noqa: F401
except ImportError:
    print('Missing dependency "flask". Run with the backend venv: backend/venv/bin/python tests/rag_doc_id_validation.test.py')
    sys.exit(1)

from doc_ids import validate_doc_id, validate_doc_ids  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def rejects(fn, value, label):
    try:
        out = fn(value)
        check(f'{label} rejects {value!r}', False, f'accepted -> {out!r}')
    except ValueError:
        check(f'{label} rejects {value!r}', True)


print('\n--- Part A: validators ---')
INJECTIONS = ['1 OR 1 = 1', '1) OR (1 = 1', "1; DROP TABLE x", '1 OR doc_id > 0', "'a'", 'abc', '1.5', '', ' ', '1e3',
              '0x10', '1 --', True, False, None, 1.0, [1], {'id': 1}, '9' * 19]
for bad in INJECTIONS:
    rejects(validate_doc_id, bad, 'validate_doc_id')
for good, expected in [(1, 1), (0, 0), (123456, 123456), ('42', 42), (' 7 ', 7), ('-3', -3), ('0', 0)]:
    try:
        check(f'validate_doc_id accepts {good!r} -> {expected}', validate_doc_id(good) == expected)
    except ValueError as e:
        check(f'validate_doc_id accepts {good!r}', False, str(e))
check('validate_doc_ids(None) -> []', validate_doc_ids(None) == [])
check('validate_doc_ids([]) -> []', validate_doc_ids([]) == [])
check('validate_doc_ids mixed valid list', validate_doc_ids([1, '2', 3]) == [1, 2, 3])
for bad in [['1 OR 1 = 1'], [1, 'x'], '1,2', {'a': 1}, [None], [[1]]]:
    rejects(validate_doc_ids, bad, 'validate_doc_ids')

print('\n--- Part B: routes ---')
import extensions  # noqa: E402
import rag_chat  # noqa: E402

store_calls = []


class FakeStore:
    def search(self, query, top_k=5, dataset_ids=None):
        store_calls.append(('search', dataset_ids))
        return []

    def index_document(self, doc_id, title, content, category):
        store_calls.append(('index', doc_id))
        return {'indexed': True, 'checksum': 'x', 'chunks': 1}


rag_chat.get_vector_db = lambda: FakeStore()
extensions.VECTOR_DB_AVAILABLE = True
app = extensions.app
if 'rag_chat' not in app.blueprints:
    app.register_blueprint(rag_chat.rag_chat)
client = app.test_client()
H = {'X-App-Token': os.environ['APP_AUTH_TOKEN']}

search_url = None
index_url = None
for rule in app.url_map.iter_rules():
    if rule.endpoint == 'rag_chat.search_embeddings':
        search_url = rule.rule
    if rule.endpoint == 'rag_chat.index_documents':
        index_url = rule.rule
check('search/index routes located', bool(search_url) and bool(index_url), f'{search_url} {index_url}')

for bad in ['1 OR 1 = 1', '1) OR (1 = 1', 'abc', 1.5, True]:
    store_calls.clear()
    r = client.post(search_url, json={'query': 'q', 'dataset_ids': [bad]}, headers=H)
    check(f'search with dataset_ids=[{bad!r}] -> 400', r.status_code == 400, f'{r.status_code} {r.get_json()}')
    check(f'  ...and the store was never called', store_calls == [])
store_calls.clear()
r = client.post(search_url, json={'query': 'q', 'dataset_ids': '1 OR 1 = 1'}, headers=H)
check('search with dataset_ids as a string -> 400', r.status_code == 400 and store_calls == [], f'{r.status_code}')
store_calls.clear()
r = client.post(search_url, json={'query': 'q', 'dataset_ids': [1, '2']}, headers=H)
check('search with valid ids -> 200 and ints reach the store', r.status_code == 200 and store_calls == [('search', [1, 2])], f'{r.status_code} {store_calls}')
store_calls.clear()
r = client.post(search_url, json={'query': 'q'}, headers=H)
check('search without dataset_ids -> 200 with []', r.status_code == 200 and store_calls == [('search', [])], f'{r.status_code} {store_calls}')

store_calls.clear()
r = client.post(index_url, json={'documents': [{'id': '1 OR 1 = 1', 'title': 't', 'content': 'c'}]}, headers=H)
check('index with injected id -> 400, store untouched', r.status_code == 400 and store_calls == [], f'{r.status_code} {r.get_json()}')
store_calls.clear()
r = client.post(index_url, json={'documents': [{'id': '7', 'title': 't', 'content': 'c'}]}, headers=H)
check('index with valid id -> 200, int reaches the store', r.status_code == 200 and store_calls == [('index', 7)], f'{r.status_code} {store_calls}')

print('\n--- Part C: VectorDBManager without a table ---')
try:
    import vector_db  # heavy imports (lancedb/fastembed); skip gracefully if unavailable
    mgr = vector_db.VectorDBManager.__new__(vector_db.VectorDBManager)
    mgr.table = None
    mgr.embedding_model = None
    try:
        mgr.search('q', dataset_ids=['1 OR 1 = 1'])
        check('VectorDBManager.search validates before table check', False, 'no error')
    except ValueError:
        check('VectorDBManager.search validates before table check', True)
    check('VectorDBManager.search with valid ids and no table -> []', mgr.search('q', dataset_ids=[1]) == [])
    try:
        mgr.delete_document('1; DROP')
        check('VectorDBManager.delete_document validates', False, 'no error')
    except ValueError:
        check('VectorDBManager.delete_document validates', True)
except ImportError as e:
    check(f'vector_db import skipped ({e})', True)

failed = [n for n, p in results if not p]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
