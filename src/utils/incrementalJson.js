/**
 * Incremental JSON serialization for large exports.
 *
 * `JSON.stringify(exportData, replacer, 2)` on a database backup that
 * embeds every media blob as base64 is a single synchronous call: the UI is
 * frozen for its whole duration and the result has to fit in ONE JS string
 * (V8 caps strings at ~1GB, and a copy of that size is a real memory spike).
 *
 * stringifyToParts produces byte-identical output - same replacer and
 * indentation semantics as JSON.stringify - but serializes the top-level
 * collection one element at a time, reporting progress and yielding to the
 * event loop between elements so the progress modal can paint. It returns
 * an array of string fragments that can be handed straight to
 * `new Blob(parts)`, which assembles the file without ever concatenating
 * the fragments into a single string.
 *
 * Only the top level is split: a root array is emitted per element, and a
 * root object is emitted per property with its array-valued properties
 * (documents, media, ...) further split per element. Everything nested
 * deeper goes through a plain JSON.stringify, which is where the native
 * speed lives anyway.
 *
 * Replacer caveat: for a split-out element the replacer sees '' as the key
 * of that element (it is the root of its own JSON.stringify call) instead
 * of its array index / property name. The replacers in this app only look
 * at the value, never the key, so this is transparent to them.
 */

/**
 * @param {*} value - Root value to serialize
 * @param {object} [options]
 * @param {Function|null} [options.replacer] - JSON.stringify replacer
 * @param {number} [options.indent=2] - Indentation width (0 = compact)
 * @param {Function|null} [options.onProgress] - (current, total, key) per
 *   emitted element of a split collection; `key` is the property name for
 *   a root object's arrays, null for a root array
 * @param {Function|null} [options.yielder] - awaited after each emitted
 *   element (see createYielder in yieldToUI.js)
 * @returns {Promise<string[]>} JSON text fragments, in order
 */
export async function stringifyToParts(value, options = {}) {
  const {
    replacer = null,
    indent = 2,
    onProgress = null,
    yielder = null,
  } = options;

  const parts = [];
  const nl = indent > 0 ? '\n' : '';
  const colon = indent > 0 ? ': ' : ':';
  const pad = (depth) => (indent > 0 ? ' '.repeat(indent * depth) : '');

  // Serialize a nested value exactly as JSON.stringify would render it when
  // nested `depth` levels deep: stringify at the root indentation, then
  // re-indent every line break. Returns undefined where JSON.stringify
  // does (functions, undefined, symbols) so callers can apply the
  // "omit object property" / "null array slot" rules.
  const leaf = (v, depth) => {
    const s = JSON.stringify(v, replacer, indent);
    if (s === undefined || depth === 0 || indent === 0) return s;
    return s.replace(/\n/g, '\n' + pad(depth));
  };

  const emitArray = async (arr, depth, key) => {
    if (arr.length === 0) {
      parts.push('[]');
      return;
    }
    parts.push('[' + nl);
    for (let i = 0; i < arr.length; i++) {
      const s = leaf(arr[i], depth + 1);
      parts.push(
        pad(depth + 1) + (s === undefined ? 'null' : s) + (i < arr.length - 1 ? ',' : '') + nl
      );
      if (onProgress) onProgress(i + 1, arr.length, key);
      if (yielder) await yielder();
    }
    parts.push(pad(depth) + ']');
  };

  const emitObject = async (obj, depth) => {
    // Pre-serialize the scalar/object-valued properties (cheap - the bulk of
    // an export lives in the arrays) so properties whose value would be
    // omitted by JSON.stringify can be dropped before commas are decided.
    const entries = [];
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (Array.isArray(v)) {
        entries.push({ key, array: v });
      } else {
        const s = leaf(v, depth + 1);
        if (s !== undefined) entries.push({ key, text: s });
      }
    }
    if (entries.length === 0) {
      parts.push('{}');
      return;
    }
    parts.push('{' + nl);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      parts.push(pad(depth + 1) + JSON.stringify(entry.key) + colon);
      if (entry.array) {
        await emitArray(entry.array, depth + 1, entry.key);
      } else {
        parts.push(entry.text);
      }
      parts.push((i < entries.length - 1 ? ',' : '') + nl);
    }
    parts.push(pad(depth) + '}');
  };

  if (Array.isArray(value)) {
    await emitArray(value, 0, null);
  } else if (value && typeof value === 'object' && typeof value.toJSON !== 'function') {
    await emitObject(value, 0);
  } else {
    const s = leaf(value, 0);
    parts.push(s === undefined ? 'null' : s);
  }

  return parts;
}
