"""
The account's synchronisation API (accounts mode; backend/sync_store.py).

    GET  /api/sync/status                 {enabled, latest, records, tombstones, now}
    POST /api/sync/push                   {device, changes: [...]} -> {results: [...], latest}
    GET  /api/sync/pull?since=<seq>&limit {changes, seq, latest, more}
    GET  /api/sync/versions?collection=&key=   the kept versions of one record
    GET  /api/sync/record?collection=&key=     one record as the server has it

Every route acts on the signed-in account's own store; outside accounts
mode the routes answer 404 (the desktop reaches a server with a device
token in a later phase).
"""
from flask import Blueprint, jsonify, request
import time

from sync_store import SyncStore
from user_context import accounts_mode, current_user

sync_api = Blueprint('sync_api', __name__)


def _store():
    if not accounts_mode() or not current_user():
        return None
    return SyncStore()


@sync_api.route('/api/sync/status', methods=['GET'])
def sync_status():
    store = _store()
    if store is None:
        return jsonify({'enabled': False}), 404
    try:
        counts = store.counts()
    finally:
        store.close()
    return jsonify({'enabled': True, 'now': time.time() * 1000.0, **counts})


@sync_api.route('/api/sync/push', methods=['POST'])
def sync_push():
    store = _store()
    if store is None:
        return jsonify({'error': 'Synchronisation is not available here'}), 404
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get('changes'), list):
        store.close()
        return jsonify({'error': 'JSON {"device", "changes": [...]} expected'}), 400
    if len(body['changes']) > 500:
        store.close()
        return jsonify({'error': 'at most 500 changes per push'}), 400
    try:
        # a device that knows an older generation holds data that was
        # deleted on purpose: it must empty itself, not push it back
        if body.get('generation') is not None and int(body['generation']) != store.generation():
            return jsonify({'error': 'The account\'s data was reset on the server: this device must synchronise again from scratch', 'code': 'STALE_GENERATION', 'generation': store.generation()}), 409
        results = store.push(body['changes'], body.get('device'))
        latest = store.latest_seq()
        generation = store.generation()
    finally:
        store.close()
    return jsonify({'results': results, 'latest': latest, 'generation': generation, 'now': time.time() * 1000.0})


@sync_api.route('/api/sync/pull', methods=['GET'])
def sync_pull():
    store = _store()
    if store is None:
        return jsonify({'error': 'Synchronisation is not available here'}), 404
    try:
        answer = store.pull(request.args.get('since', 0), request.args.get('limit', 500))
    finally:
        store.close()
    answer['now'] = time.time() * 1000.0
    return jsonify(answer)


@sync_api.route('/api/sync/versions', methods=['GET'])
def sync_versions():
    store = _store()
    if store is None:
        return jsonify({'error': 'Synchronisation is not available here'}), 404
    collection = request.args.get('collection', '')
    key = request.args.get('key', '')
    if not collection or not key:
        store.close()
        return jsonify({'error': 'collection and key are required'}), 400
    try:
        return jsonify({'versions': store.versions(collection, key), 'current': store.get(collection, key)})
    finally:
        store.close()


@sync_api.route('/api/sync/record', methods=['GET'])
def sync_record():
    store = _store()
    if store is None:
        return jsonify({'error': 'Synchronisation is not available here'}), 404
    collection = request.args.get('collection', '')
    key = request.args.get('key', '')
    try:
        record = store.get(collection, key) if collection and key else None
    finally:
        store.close()
    if record is None:
        return jsonify({'error': 'no such record'}), 404
    return jsonify(record)
