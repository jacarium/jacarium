/**
 * Links between documents: the [[doc:...]] directive.
 *
 *   [[doc:<stableId>]]               the document's current title as the link text
 *   [[doc:<stableId>|custom text]]   custom link text
 *   [[doc:Some title]]               a title typed by hand: resolved by exact title
 *                                    (case-insensitive, trimmed); several documents with
 *                                    that title make it ambiguous
 *
 * A link stores the document's permanent stableId (src/utils/stableId.js:
 * minted once, indexed, carried through export / import and sync), never
 * its title or its per-machine Dexie id, so a rename or a move to another
 * category cannot break it: the preview and the editor's chip always show
 * the CURRENT title. A document that is not on this device (deleted, or a
 * shared document whose target the reader lacks) renders as a muted
 * "Document not found" with the raw label, not clickable.
 *
 * Pure: a resolver is built from the documents' metadata (createDocLinkResolver)
 * and handed to the renderer (src/utils/interactiveMarkdown.js), the editor's
 * chips (codemirror/docLinkChips.js) and the PDF export; the editor's picker
 * uses docLinkContextAt / searchDocuments. Everything that ends up in HTML
 * goes through escapeHtml here and DOMPurify in the renderer.
 */

/** A [[doc:ref]] / [[doc:ref|text]] directive. The ref and the text never span a line or contain "]]" / "|". */
export const DOC_LINK_RE = /\[\[doc:([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

const STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `ref` a stable id (a UUID) rather than a title? */
export function isStableIdRef(ref) {
  return STABLE_ID_RE.test(String(ref || '').trim());
}

/** Every directive in `text`: { from, to, raw, ref, label, byId }, in document order. */
export function findDocLinks(text) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(DOC_LINK_RE)) {
    const ref = m[1].trim();
    const label = m[2] != null ? m[2].trim() : '';
    out.push({ from: m.index, to: m.index + m[0].length, raw: m[0], ref, label, byId: isStableIdRef(ref) });
  }
  return out;
}

const titleKey = (title) => String(title || '').trim().toLowerCase();

/**
 * A resolver over the documents' metadata (id, stableId, title - what
 * getDocumentsMetadata() returns). resolve(ref) answers
 *   { status: 'found', id, stableId, title }
 *   { status: 'ambiguous', title, count }      several documents carry that title
 *   { status: 'missing' }                       no such id / title on this device
 * `documents` is the resolver's version: the preview and the chips re-render
 * when the list changes (a rename, a delete, a sync), so the title shown is
 * always the current one.
 */
export function createDocLinkResolver(documents = []) {
  const byId = new Map();
  const byTitle = new Map();
  for (const doc of documents || []) {
    if (!doc || typeof doc.stableId !== 'string' || doc.stableId === '') continue;
    const entry = { id: doc.id, stableId: doc.stableId, title: typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'Untitled' };
    byId.set(doc.stableId.toLowerCase(), entry);
    const key = titleKey(entry.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(entry);
  }
  const resolve = (ref) => {
    const r = String(ref || '').trim();
    if (!r) return { status: 'missing' };
    if (isStableIdRef(r)) {
      const hit = byId.get(r.toLowerCase());
      return hit ? { status: 'found', ...hit } : { status: 'missing' };
    }
    const hits = byTitle.get(titleKey(r)) || [];
    if (hits.length === 1) return { status: 'found', ...hits[0] };
    if (hits.length > 1) return { status: 'ambiguous', title: r, count: hits.length };
    return { status: 'missing' };
  };
  resolve.documents = documents;
  resolve.size = byId.size;
  return resolve;
}

/** The documents whose title contains `query` (case-insensitive; all of them for an empty query), newest first as given, at most `limit`. */
export function searchDocuments(documents, query, { limit = 8, excludeId = null } = {}) {
  const q = titleKey(query);
  const out = [];
  for (const doc of documents || []) {
    if (!doc || typeof doc.stableId !== 'string' || doc.stableId === '') continue;
    if (excludeId != null && doc.id === excludeId) continue;
    const title = typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'Untitled';
    if (q && !titleKey(title).includes(q)) continue;
    out.push({ id: doc.id, stableId: doc.stableId, title, category: doc.category || 'General' });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The directive the caret is in, for the picker: with the caret inside an
 * unclosed "[[doc:" on the caret's line, { start, end: caret, query, closed: false }
 * (typing after "[[doc:" searches titles); with the caret inside a closed
 * title-form directive, { start, end, query: the title, closed: true } (the
 * picker offers to convert it to the id form). null otherwise - and inside
 * code (an open fence above, an odd backtick on the line) or for an
 * id-form directive, which needs no picker.
 */
export function docLinkContextAt(text, caret, { isInsideCode = null } = {}) {
  const s = String(text || '');
  const pos = Math.max(0, Math.min(s.length, Number(caret) || 0));
  const lineStart = s.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = s.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = s.length;
  const before = s.slice(lineStart, pos);
  const open = before.lastIndexOf('[[doc:');
  if (open === -1) return null;
  const typed = before.slice(open + '[[doc:'.length);
  if (typed.includes(']]') || typed.includes('[[')) return null;
  if (isInsideCode && isInsideCode(s.slice(0, pos))) return null;
  const start = lineStart + open;
  // closed on this line after the caret?
  const after = s.slice(pos, lineEnd);
  const close = after.indexOf(']]');
  const reopen = after.indexOf('[[');
  if (close !== -1 && (reopen === -1 || close < reopen)) {
    const inner = typed + after.slice(0, close);
    const ref = inner.split('|')[0].trim();
    if (isStableIdRef(ref)) return null;
    return { start, end: pos + close + ']]'.length, query: ref, closed: true };
  }
  if (typed.includes('|')) return null;
  return { start, end: pos, query: typed.trim(), closed: false };
}

/** The directive for a document, in the id form. */
export function docLinkDirective(stableId, label = '') {
  const text = String(label || '').trim();
  return text ? `[[doc:${stableId}|${text}]]` : `[[doc:${stableId}]]`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeDocLinkText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * The HTML of one directive for the preview (src/utils/interactiveMarkdown.js
 * replaces every match with this before marked runs; DOMPurify sanitises the
 * result as part of the page). Data attributes only: the editor's delegated
 * click handler opens the document (data-doc-link = the stable id,
 * data-doc-id = this device's record), the href is "#" so the link is
 * focusable and Enter activates it. A missing or ambiguous target is a
 * muted, inert span.
 */
export function renderDocLinkHtml({ ref, label }, resolve) {
  const hit = typeof resolve === 'function' ? resolve(ref) : { status: 'missing' };
  if (hit && hit.status === 'found') {
    const text = escapeDocLinkText(label || hit.title);
    return `<a href="#" class="doc-link" data-doc-link="${escapeDocLinkText(hit.stableId)}" data-doc-id="${escapeDocLinkText(String(hit.id))}" title="Open ${escapeDocLinkText(hit.title)}">${text}</a>`;
  }
  const raw = escapeDocLinkText(label || ref);
  if (hit && hit.status === 'ambiguous') {
    return `<span class="doc-link doc-link-ambiguous" role="note" title="${hit.count} documents are titled ${escapeDocLinkText(hit.title)} - pick one with the editor's link picker" data-doc-link-ambiguous="${escapeDocLinkText(ref)}">${raw} <span class="doc-link-state">(ambiguous: ${hit.count} documents)</span></span>`;
  }
  return `<span class="doc-link doc-link-missing" role="note" title="Document not found on this device" data-doc-link-missing="${escapeDocLinkText(ref)}"><span class="doc-link-state">Document not found:</span> ${raw}</span>`;
}

/**
 * Replace every directive in `markdown` with its preview HTML - outside code:
 * a directive inside a ``` / ~~~ fence or inline `code` is left as written
 * (so the syntax can be shown in a document), the way marked will print it.
 */
export function renderDocLinks(markdown, resolve) {
  const text = String(markdown || '');
  if (!text.includes('[[doc:')) return text;
  const render = (segment) => segment.replace(DOC_LINK_RE, (raw, ref, label) => renderDocLinkHtml({ ref: ref.trim(), label: label != null ? label.trim() : '' }, resolve));
  const out = [];
  let fence = null;   // the open fence's marker characters
  for (const line of text.split('\n')) {
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; out.push(line); continue; }
    if (!line.includes('`')) { out.push(render(line)); continue; }
    // inline code: the spans between matching backtick runs stay as written
    let rendered = '';
    let rest = line;
    while (rest) {
      const open = /(`+)/.exec(rest);
      if (!open) { rendered += render(rest); break; }
      const closeIdx = rest.indexOf(open[1], open.index + open[1].length);
      if (closeIdx === -1) { rendered += render(rest); break; }
      rendered += render(rest.slice(0, open.index)) + rest.slice(open.index, closeIdx + open[1].length);
      rest = rest.slice(closeIdx + open[1].length);
    }
    out.push(rendered);
  }
  return out.join('\n');
}
