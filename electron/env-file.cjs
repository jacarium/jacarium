// Value sanitization for ~/.jacarium.env writes (the 'write-env-file'
// IPC handler in main.cjs).
//
// The file is a plain KEY=VALUE-per-line format read back by load-env.cjs
// (Electron) and python-dotenv (backend). Values were interpolated verbatim,
// so a value containing a newline - "abc\nJIRA_PAT=stolen" - injected extra
// lines that both readers would then treat as real settings. Every value
// that reaches the file therefore passes through sanitizeEnvValue():
//
//   - leading/trailing whitespace and line breaks are trimmed (a token
//     pasted from a clipboard very often carries a trailing "\n"; that is
//     benign and must keep working);
//   - any REMAINING control character (\r, \n, NUL, ...) is rejected with
//     an error naming the key, rather than silently mangled - a hidden
//     control character in the middle of an API key is never intended.
//
// Legitimate values need nothing else: API keys, tokens, emails, project ids,
// regions, booleans, comma-separated model lists and URLs contain no control
// characters, and '=', '#', ',', ' ' and quotes are all preserved as-is
// (the readers split on the FIRST '=' only and do not treat '#' mid-line as
// a comment).
//
// Kept free of Electron imports so it is unit-testable with plain Node - see
// tests/env-file-hardening.test.mjs.

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function sanitizeEnvValue(key, value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (CONTROL_CHARS.test(text)) {
    throw new Error(`Setting ${key} contains a line break or control character and cannot be saved. Remove it and try again.`);
  }
  return text;
}

/**
 * Return a copy of `envData` with every value sanitized. Keys are not
 * user-controlled (the writer only emits a fixed set of known keys), but
 * anything that is not a plain string key is dropped defensively.
 */
function sanitizeEnvData(envData) {
  const clean = {};
  if (!envData || typeof envData !== 'object') return clean;
  for (const [key, value] of Object.entries(envData)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    clean[key] = sanitizeEnvValue(key, value);
  }
  return clean;
}

module.exports = { sanitizeEnvValue, sanitizeEnvData };
