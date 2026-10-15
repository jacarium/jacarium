/**
 * Syntax highlighting for fenced code blocks in the Documents renderer
 * (src/utils/interactiveMarkdown.js renderer.code).
 *
 * Deliberately small and closed: highlight.js CORE plus exactly the five
 * grammars the Documents feature supports (python, go, bash, yaml, json).
 * There is no auto-detection - a fence is highlighted only when its info
 * string names one of those languages (or an alias below); a bare ``` fence
 * and every other language tag stay plain escaped text exactly as marked
 * renders them.
 *
 * Security: hljs.highlight() escapes the code (&, <, >, ", ') before
 * wrapping tokens in <span class="hljs-..."> elements, so hostile code
 * content can never inject markup; the output still goes through the
 * renderer's DOMPurify pass like every other block.
 *
 * Colours live in src/index.css as --os-code-* tokens (light on :root,
 * dark on .dark) applied to the .hljs-* classes, so blocks follow the app
 * theme like the .os-terminal panes do.
 */
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';

// Canonical language -> grammar. Register under the canonical name only;
// aliases are resolved by resolveHighlightLanguage() below so the grammar
// packages' own alias lists (e.g. bash's "zsh", python's "gyp") never widen
// the supported set by accident.
const GRAMMARS = { python, go, bash, yaml, json };

// Info-string spellings accepted for each supported language.
const ALIASES = {
  python: 'python', py: 'python', python3: 'python',
  go: 'go', golang: 'go',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
  yaml: 'yaml', yml: 'yaml',
  json: 'json',
};

/** The canonical names of the supported languages, for tests/docs. */
export const HIGHLIGHT_LANGUAGES = Object.freeze(Object.keys(GRAMMARS));

let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  for (const [name, grammar] of Object.entries(GRAMMARS)) {
    hljs.registerLanguage(name, grammar);
  }
  // The registry only ever holds these five grammars, and highlightAuto()
  // is never called, so nothing outside the supported set can be detected.
}

/**
 * Map a fence info string ("python", "Py", "yaml title=x", "sh") to the
 * canonical supported language, or null when the fence must stay plain.
 * @param {string} info - the fence's raw info string (may be empty)
 * @returns {'python'|'go'|'bash'|'yaml'|'json'|null}
 */
export function resolveHighlightLanguage(info) {
  const first = String(info || '').trim().split(/\s+/)[0].toLowerCase();
  if (!first) return null;
  return Object.prototype.hasOwnProperty.call(ALIASES, first) ? ALIASES[first] : null;
}

// Small memo so re-parsing a long document on every preview refresh (the
// whole markdown is re-rendered when the source changes) does not re-tokenize
// code blocks that did not change. Bounded: oldest entries are evicted.
const CACHE_LIMIT = 200;
const cache = new Map();

/**
 * Highlight `code` as `language` (a canonical name from
 * resolveHighlightLanguage). Returns HTML-escaped markup with
 * <span class="hljs-*"> tokens, never raw code. Returns null when the
 * language is not supported or highlighting fails, so the caller falls back
 * to the plain escaped rendering.
 * @param {string} code
 * @param {string} language
 * @returns {string|null}
 */
export function highlightCode(code, language) {
  if (!GRAMMARS[language]) return null;
  const key = language + '\u0000' + code;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  ensureRegistered();
  let html;
  try {
    // hljs.highlight() with an explicit language never auto-detects;
    // ignoreIllegals keeps a stray token from failing the whole block.
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch (err) {
    console.warn('[codeHighlight] highlight failed, rendering plain:', err);
    return null;
  }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return html;
}
