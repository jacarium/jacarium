/**
 * What the AI chat sends as context ("Add as AI Context" on a document or a
 * Kanban board), and the privacy redaction over it.
 *
 * A context is the item's CONTENT - a document's markdown, a board rendered
 * as markdown - in a delimited block the model can tell from the question:
 *
 *   --- Document: <title> (category: <category>) ---
 *   <content>
 *   --- End of document ---
 *
 * Before it goes out, redactText() hides the values that look private:
 * tokens, keys and passwords (type 'token'), hostnames ('host'), IP
 * addresses ('ip'), email addresses ('email') and user names ('username').
 * Each hidden value becomes a placeholder the model cannot mistake for a
 * real one - [REDACTED_HOST_1], [REDACTED_TOKEN_2] (ASCII: upper-case type,
 * underscores) - the same placeholder for every occurrence of that value
 * within a context, and the message carries REDACTION_NOTE so the model
 * keeps the placeholders as they are. PLACEHOLDER_LABELS maps a type id to
 * its placeholder word (username -> USER).
 *
 * Public names are not private: registries, package indexes and well-known
 * vendors (PUBLIC_HOSTS: ghcr.io, quay.io, docker.io, registry.redhat.io,
 * gcr.io, github.com, pypi.org, npmjs.org...), file names (an extension as
 * the last label), path segments and version strings are left alone.
 * The user's own allow / deny lists (src/utils/aiPrivacy.js, kept on the
 * device) are consulted before the rules: an allowed value is never hidden,
 * a denied value always is. Per chat, the user can switch a type off, send
 * one finding as is, or turn the redaction off (policy / decisions).
 */

export const REDACTION_NOTE = 'Values written as [REDACTED_...] are hidden for privacy; keep them as they are and do not treat them as real hosts, addresses, names or secrets.';

export const REDACTION_TYPES = [
  { id: 'token', label: 'Tokens & keys', description: 'API keys, access tokens, passwords, private keys', sensitive: true },
  { id: 'host', label: 'Hosts', description: 'Hostnames and domains that are not public registries or vendors' },
  { id: 'ip', label: 'IP addresses', description: 'IPv4 addresses' },
  { id: 'email', label: 'Emails', description: 'Email addresses' },
  { id: 'username', label: 'Usernames', description: 'user= / login= values, home directories' },
];

export const DEFAULT_POLICY = Object.freeze({ enabled: true, types: Object.freeze({ token: true, host: true, ip: true, email: true, username: true }) });

/** Registries, package indexes and vendors: public names, never private (exact or any subdomain). */
export const PUBLIC_HOSTS = [
  'ghcr.io', 'quay.io', 'docker.io', 'docker.com', 'hub.docker.com', 'registry.redhat.io', 'registry.access.redhat.com', 'registry.connect.redhat.com', 'gcr.io', 'registry.k8s.io', 'k8s.gcr.io', 'mcr.microsoft.com', 'public.ecr.aws', 'gallery.ecr.aws',
  'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'pypi.org', 'pythonhosted.org', 'npmjs.org', 'npmjs.com', 'nodejs.org', 'python.org', 'golang.org', 'go.dev', 'pkg.go.dev', 'crates.io', 'rubygems.org', 'maven.org', 'nuget.org', 'packagist.org',
  'kubernetes.io', 'k8s.io', 'helm.sh', 'cncf.io', 'redhat.com', 'access.redhat.com', 'openshift.com', 'fedoraproject.org', 'centos.org', 'debian.org', 'ubuntu.com', 'canonical.com', 'archlinux.org', 'opensuse.org', 'suse.com', 'alpinelinux.org',
  'apache.org', 'mozilla.org', 'microsoft.com', 'google.com', 'googleapis.com', 'gstatic.com', 'apple.com', 'amazon.com', 'cloudflare.com', 'wikipedia.org', 'stackoverflow.com', 'stackexchange.com', 'medium.com', 'readthedocs.io', 'w3.org', 'ietf.org', 'rfc-editor.org', 'letsencrypt.org',
  'example.com', 'example.org', 'example.net', 'localhost', 'localhost.localdomain', 'jacarium.com', 'anthropic.com', 'openai.com', 'ollama.com', 'ollama.ai', 'huggingface.co', 'atlassian.net', 'atlassian.com', 'jira.com', 'slack.com', 'zoom.us',
];

// a dotted name whose last label is a file extension is a file name, not a host
const FILE_EXTENSIONS = new Set(['gz', 'tgz', 'bz2', 'xz', 'zip', 'tar', 'rar', '7z', 'yaml', 'yml', 'json', 'txt', 'md', 'log', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'pyc', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'java', 'jar', 'war', 'class', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'pl', 'pm', 'lua', 'sql', 'db', 'sqlite', 'conf', 'cfg', 'ini', 'toml', 'env', 'properties', 'service', 'socket', 'timer', 'desktop', 'spec', 'rpm', 'deb', 'apk', 'dmg', 'exe', 'dll', 'so', 'dylib', 'bin', 'img', 'iso', 'qcow2', 'vmdk', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'ttf', 'otf', 'woff', 'woff2', 'crt', 'cer', 'pem', 'key', 'csr', 'p12', 'pfx', 'jks', 'lock', 'bak', 'tmp', 'old', 'orig', 'patch', 'diff', 'pid', 'sock', 'map', 'min', 'test', 'cjs', 'd', 'asar', 'tex', 'bib', 'rst', 'adoc', 'txt']);

export const PLACEHOLDER_LABELS = { token: 'TOKEN', host: 'HOST', ip: 'IP', email: 'EMAIL', username: 'USER', custom: 'VALUE' };
const PLACEHOLDER = (type, n) => `[REDACTED_${PLACEHOLDER_LABELS[type] || String(type).toUpperCase()}_${n}]`;
export const PLACEHOLDER_PATTERN = /\[REDACTED_[A-Z]+_\d+\]/g;

/**
 * The text of a chat bubble before Markdown: a placeholder at the start of
 * a line followed by a colon ("[REDACTED_HOST_1]: 10.0.0.5") is a link
 * reference definition to marked, which would swallow the line; the
 * bracket is escaped there (outside fenced code, where escapes would show).
 * Anywhere else a bare [REDACTED_HOST_1] renders as plain text.
 */
export function protectPlaceholdersForMarkdown(text) {
  if (typeof text !== 'string' || !text.includes('[REDACTED_')) return text;
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.replace(/^(\s{0,3})(\[REDACTED_[A-Z]+_\d+\]):/, '$1\\$2:');
  }).join('\n');
}

/** Is `host` (lower case) public: in the list, or under one of its names? */
export function isPublicHost(host, extra = []) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return [...PUBLIC_HOSTS, ...extra].some((p) => { const q = String(p).toLowerCase(); return h === q || h.endsWith('.' + q); });
}

const inList = (value, list) => list.some((v) => String(v).toLowerCase() === String(value).toLowerCase());

/* ------------------------------------------------------------------ */
/* The rules                                                           */
/* ------------------------------------------------------------------ */

const KEY_NAMES = '(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer[_-]?token|session[_-]?key)';
const looksLikePlaceholder = (v) => /^[<$*{[#]|^(\*+|xxx+|changeme|redacted|none|null|undefined|true|false)$/i.test(v) || PLACEHOLDER_PATTERN.test(v);

// each rule: { type, re (global), value: match -> the value (null = not a finding) }
const RULES = [
  { type: 'token', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, value: (m) => m[0] },
  { type: 'token', re: /\bAKIA[0-9A-Z]{16}\b/g, value: (m) => m[0] },
  { type: 'token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/g, value: (m) => m[0] },
  { type: 'token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, value: (m) => m[0] },
  { type: 'token', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, value: (m) => m[0] },
  { type: 'token', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, value: (m) => m[0] },
  { type: 'token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, value: (m) => m[0] },
  { type: 'token', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, value: (m) => m[1], offset: (m) => m[0].length - m[1].length },
  { type: 'token', re: new RegExp(`\\b${KEY_NAMES}\\b\\s*[:=]\\s*["']?([^\\s"',;]{4,})`, 'gi'), value: (m) => (looksLikePlaceholder(m[1]) ? null : m[1]), offset: (m) => m[0].length - m[1].length },
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, value: (m) => m[0] },
  { type: 'ip', re: /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g, value: (m) => ([m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255) && !/^(0\.0\.0\.0|127\.0\.0\.1)$/.test(m[0]) ? m[0] : null) },
  { type: 'host', re: /(?<![\w.@/\\-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,}(?:\.[a-z]{2,})?)(?![\w-])/gi, value: (m, ctx) => hostValue(m[1], ctx) },
  { type: 'host', re: /\b(?:node|server|host|vm|worker|master|controller|db|web|app|k8s|ocp)-?\d+\b/gi, value: (m) => m[0] },
  { type: 'username', re: /\b(?:user(?:name)?|login|uid|owner)\s*[:=]\s*["']?([A-Za-z][A-Za-z0-9._-]{1,})/gi, value: (m) => (looksLikePlaceholder(m[1]) ? null : m[1]), offset: (m) => m[0].length - m[1].length },
  { type: 'username', re: /\/(?:home|Users)\/([A-Za-z][A-Za-z0-9._-]+)/g, value: (m) => m[1], offset: (m) => m[0].length - m[1].length },
];

function hostValue(raw, ctx) {
  const host = raw.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const last = labels[labels.length - 1];
  if (labels.length < 2) return null;
  if (!/^[a-z]{2,}$/.test(last)) return null;                 // "python3.11", "1.2": no TLD
  if (FILE_EXTENSIONS.has(last)) return null;                 // a file name
  if (labels.some((l) => /^\d+$/.test(l)) && labels.length < 3) return null;
  if (isPublicHost(host, ctx.publicHosts)) return null;
  return raw;
}

/* ------------------------------------------------------------------ */
/* Finding and redacting                                               */
/* ------------------------------------------------------------------ */

/**
 * Every private-looking value in `text`: [{ id, type, value, count }] in
 * order of first appearance. allow: values never hidden (an allowed host
 * covers its subdomains); deny: values always hidden (type 'custom').
 */
export function findSensitive(text, { allow = [], deny = [] } = {}) {
  return collect(String(text || ''), { allow, deny }).findings;
}

function collect(text, { allow = [], deny = [] }) {
  const matches = [];   // { start, end, type, value }
  const ctx = { publicHosts: allow };
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0] === '') { rule.re.lastIndex++; continue; }
      const value = rule.value(m, ctx);
      if (!value) continue;
      if (inList(value, allow) || (rule.type === 'host' && isPublicHost(value, allow))) continue;
      const start = m.index + (rule.offset ? rule.offset(m) : 0);
      matches.push({ start, end: start + value.length, type: rule.type, value });
    }
  }
  for (const value of deny) {
    const needle = String(value || '');
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const i = text.toLowerCase().indexOf(needle.toLowerCase(), from);
      if (i === -1) break;
      matches.push({ start: i, end: i + needle.length, type: 'custom', value: text.slice(i, i + needle.length) });
      from = i + needle.length;
    }
  }
  // earlier start wins; on the same start the longer match; no overlaps
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let cursor = 0;
  for (const m of matches) { if (m.start < cursor) continue; kept.push(m); cursor = m.end; }
  // placeholders per (type, value) in order of first appearance
  const findings = [];
  const byKey = new Map();
  const counters = {};
  for (const m of kept) {
    const key = `${m.type}:${m.value.toLowerCase()}`;
    let f = byKey.get(key);
    if (!f) {
      counters[m.type] = (counters[m.type] || 0) + 1;
      f = { id: key, type: m.type, value: m.value, placeholder: PLACEHOLDER(m.type, counters[m.type]), count: 0 };
      byKey.set(key, f);
      findings.push(f);
    }
    f.count++;
    m.finding = f;
  }
  return { matches: kept, findings };
}

/**
 * The text with the private values replaced by placeholders, and the
 * findings with `hidden` per the policy (the type switches, the chat's
 * on/off), the decisions ({ findingId: 'hide' | 'send' }) and the lists.
 */
export function redactText(text, { policy = DEFAULT_POLICY, decisions = {}, allow = [], deny = [] } = {}) {
  const source = String(text || '');
  const { matches, findings } = collect(source, { allow, deny });
  for (const f of findings) {
    const typeOn = f.type === 'custom' ? true : policy.types?.[f.type] !== false;
    f.hidden = policy.enabled !== false && typeOn && decisions[f.id] !== 'send';
  }
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (!m.finding.hidden) continue;
    out += source.slice(cursor, m.start) + m.finding.placeholder;
    cursor = m.end;
  }
  out += source.slice(cursor);
  return { text: out, findings };
}

/** "gh••••••3f" - the shape of a value without the value. */
export function maskValue(value) {
  const v = String(value || '');
  if (v.length <= 6) return '•'.repeat(Math.max(3, v.length));
  return v.slice(0, 2) + '•'.repeat(Math.min(8, v.length - 4)) + v.slice(-2);
}

/* ------------------------------------------------------------------ */
/* The blocks the model receives                                       */
/* ------------------------------------------------------------------ */

const KIND_LABEL = { document: 'Document', kanban: 'Kanban board', selection: 'Selection from document' };
const KIND_END = { document: 'End of document', kanban: 'End of board', selection: 'End of selection' };

/** The delimited block for one context. */
export function formatContextBlock({ kind = 'document', title, category, text }) {
  const label = KIND_LABEL[kind] || 'Document';
  const header = `--- ${label}: ${title || 'Untitled'}${category && kind !== 'selection' ? ` (category: ${category})` : ''} ---`;
  return `${header}\n${String(text ?? '').replace(/\s+$/, '')}\n--- ${KIND_END[kind] || 'End of document'} ---`;
}

/** The first message's text: the blocks (with the redaction note when a placeholder is in them), then the question. */
export function buildContextMessage(blocks, question) {
  const body = blocks.filter(Boolean).join('\n\n');
  const note = PLACEHOLDER_PATTERN.test(body) ? `${REDACTION_NOTE}\n\n` : '';
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return `I'm providing context for my questions.\n\n${note}${body}\n\nQuestion: ${question}`;
}

/** The payload "Add as AI Context" dispatches for a document. */
export function documentContextPayload(doc) {
  return { kind: 'document', title: doc?.title || 'Untitled', category: doc?.category || '', content: String(doc?.content ?? ''), source: { kind: 'document', id: doc?.id } };
}

/** A Kanban board as markdown: one section per column, its cards as a list. */
export function kanbanBoardMarkdown(board, cards = []) {
  const columns = Array.isArray(board?.columns) && board.columns.length ? board.columns : [{ id: null, title: 'Cards' }];
  const lines = [];
  if (board?.description) lines.push(String(board.description), '');
  for (const col of columns) {
    const inColumn = cards.filter((c) => (col.id == null ? true : c.status === col.id));
    lines.push(`## ${col.title || col.id}`);
    if (!inColumn.length) lines.push('_(no cards)_');
    for (const c of inColumn) {
      const extras = [c.priority && `priority: ${c.priority}`, c.dueDate && `due: ${c.dueDate}`, Array.isArray(c.labels) && c.labels.length && `labels: ${c.labels.join(', ')}`].filter(Boolean);
      lines.push(`- **${c.title || 'Untitled'}**${extras.length ? ` (${extras.join('; ')})` : ''}${c.description ? `\n  ${String(c.description).replace(/\n/g, '\n  ')}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\s+$/, '');
}

/** The payload "Add as AI Context" dispatches for a board. */
export function kanbanContextPayload(board, cards = []) {
  return { kind: 'kanban', title: board?.title || 'Untitled board', category: board?.category || '', content: kanbanBoardMarkdown(board, cards), source: { kind: 'kanban', id: board?.id } };
}

/** The payload for a highlighted passage of a document (the editor's selection menu). */
export function selectionContextPayload(doc, text) {
  return { kind: 'selection', title: doc?.title || 'Untitled', category: doc?.category || '', content: String(text ?? ''), source: { kind: 'selection', id: doc?.id } };
}

/**
 * A chat's context as kept on the conversation: { id, kind, title,
 * category, raw, source, policy, decisions, manual }. The text the model
 * receives is derived here - the block over the redacted raw content, or
 * the hand-edited text (`manual`) once the user edited it in the dialog:
 * an edit freezes the text, so the switches and per-finding choices stop
 * applying until "Reset" drops the edit (the robust way round: the two
 * never fight, and the preview is always exactly what is sent).
 */
export function newContext(payload) {
  return { id: `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kind: payload.kind || 'document', title: payload.title || 'Untitled', category: payload.category || '', raw: String(payload.content ?? ''), source: payload.source || null, policy: { enabled: true, types: { ...DEFAULT_POLICY.types } }, decisions: {}, manual: null };
}

/** { text, findings, hidden, edited } for a context under the device's lists. */
export function renderContext(ctx, lists = { allow: [], deny: [] }) {
  const { text, findings } = redactText(ctx.raw, { policy: ctx.policy || DEFAULT_POLICY, decisions: ctx.decisions || {}, allow: lists.allow || [], deny: lists.deny || [] });
  const edited = typeof ctx.manual === 'string';
  const block = edited ? ctx.manual : formatContextBlock({ kind: ctx.kind, title: ctx.title, category: ctx.category, text });
  return { text: block, findings, hidden: edited ? 0 : findings.filter((f) => f.hidden).length, edited };
}

/** "3 hidden" for a chip; '' when nothing is hidden. */
export function hiddenSummary(findings) {
  const n = (findings || []).filter((f) => f.hidden).length;
  return n ? `${n} hidden` : '';
}
