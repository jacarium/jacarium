import { useState } from 'react';
import { Copy, Check, KeyRound } from 'lucide-react';

// Standard English letter frequency order, most to least common. Used by the
// "Auto-Guess by Frequency" heuristic - a common cryptogram-solving starting
// point (most frequent cipher letter is probably E, and so on).
const ENGLISH_FREQUENCY_ORDER = 'ETAOINSHRDLUCMFWYPVBGKJQXZ';

// Segment into user-perceived characters (grapheme clusters), same as
// HistogramTool, so multi-codepoint emoji (ZWJ sequences, flags) and CJK
// characters are treated as single units instead of broken surrogate halves.
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

const segment = (text) => [...SEGMENTER.segment(text)].map((s) => s.segment);

const isAsciiLetter = (grapheme) => /^[a-zA-Z]$/.test(grapheme);

// Key-map keys/values are stored normalized: ASCII letters uppercased, every
// other grapheme (CJK, emoji, digits, punctuation) kept as-is.
const normalizeGrapheme = (grapheme) =>
  isAsciiLetter(grapheme) ? grapheme.toUpperCase() : grapheme;

const firstGrapheme = (text) => {
  const graphemes = segment(text);
  return graphemes.length > 0 ? graphemes[0] : '';
};

/**
 * Apply a substitution map to text, grapheme by grapheme. Unmapped graphemes
 * (including whitespace, digits, punctuation) pass through unchanged. Case is
 * preserved only when both the source and mapped characters are plain ASCII
 * letters - CJK/emoji have no case concept and substitute directly.
 */
function applyKey(text, map) {
  return segment(text)
    .map((grapheme) => {
      const mapped = map[normalizeGrapheme(grapheme)];
      if (!mapped) return grapheme;
      if (isAsciiLetter(grapheme) && isAsciiLetter(mapped) && /[a-z]/.test(grapheme)) {
        return mapped.toLowerCase();
      }
      return mapped;
    })
    .join('');
}

/** Invert cipher->plain into plain->cipher, skipping blank entries. */
function invertKey(map) {
  const inverse = {};
  Object.entries(map).forEach(([cipherChar, plainChar]) => {
    if (plainChar && !(plainChar in inverse)) {
      inverse[plainChar] = cipherChar;
    }
  });
  return inverse;
}

/**
 * Walk aligned plaintext/ciphertext grapheme arrays and record
 * cipher-grapheme -> plain-grapheme mappings on top of baseMap.
 * Conflicts are collected but never block: first-seen mapping wins.
 */
function deriveKey(plainText, cipherText, baseMap) {
  const plainArr = segment(plainText);
  const cipherArr = segment(cipherText);
  const length = Math.min(plainArr.length, cipherArr.length);

  const map = { ...baseMap };
  const plainOwner = {};
  Object.entries(map).forEach(([cipherChar, plainChar]) => {
    if (plainChar && !(plainChar in plainOwner)) plainOwner[plainChar] = cipherChar;
  });

  const conflicts = new Set();
  for (let i = 0; i < length; i++) {
    if (!plainArr[i].trim() || !cipherArr[i].trim()) continue;
    const cipherChar = normalizeGrapheme(cipherArr[i]);
    const plainChar = normalizeGrapheme(plainArr[i]);

    if (map[cipherChar]) {
      if (map[cipherChar] !== plainChar) {
        conflicts.add(
          `"${cipherChar}" maps to both "${map[cipherChar]}" and "${plainChar}" (kept "${map[cipherChar]}")`
        );
      }
      continue;
    }
    if (plainOwner[plainChar] && plainOwner[plainChar] !== cipherChar) {
      conflicts.add(
        `"${plainChar}" is claimed by both "${plainOwner[plainChar]}" and "${cipherChar}"`
      );
    }
    map[cipherChar] = plainChar;
    if (!plainOwner[plainChar]) plainOwner[plainChar] = cipherChar;
  }

  const messages = [...conflicts];
  if (plainArr.length !== cipherArr.length) {
    messages.push(
      `Inputs differ in length - compared first ${length} character${length === 1 ? '' : 's'}`
    );
  }
  return { map, warning: messages.join('; ') };
}

/**
 * SubstitutionCipherTool - cryptogram-solving lab for monoalphabetic
 * substitution ciphers.
 *
 * Derive a key from a known plaintext/ciphertext pair, edit the key mapping
 * by hand, live-decode/encode text in a playground, and inspect ciphertext
 * character frequency. Fully Unicode-grapheme based: emoji (including ZWJ
 * sequences and flags) and CJK characters are single substitution units.
 */
export default function SubstitutionCipherTool() {
  // Dynamic map of ciphertext grapheme -> plaintext grapheme (or '').
  // Grown from derived/typed entries, never a pre-seeded fixed alphabet.
  const [keyMap, setKeyMap] = useState({});
  const [derivePlain, setDerivePlain] = useState('');
  const [deriveCipher, setDeriveCipher] = useState('');
  const [deriveWarning, setDeriveWarning] = useState('');
  const [playgroundCipher, setPlaygroundCipher] = useState('');
  const [playgroundPlain, setPlaygroundPlain] = useState('');
  const [copied, setCopied] = useState(null);
  const [keySort, setKeySort] = useState('appearance');

  const handleDeriveKey = () => {
    const { map, warning } = deriveKey(derivePlain, deriveCipher, keyMap);
    setKeyMap(map);
    setDeriveWarning(warning);
  };

  const handleKeyEdit = (cipherChar, value) => {
    // A single "character" can be several UTF-16 code units (surrogate pairs,
    // ZWJ sequences), so take the first grapheme of whatever was typed/pasted
    // instead of relying on maxLength.
    const grapheme = firstGrapheme(value);
    setKeyMap((prev) => ({
      ...prev,
      [cipherChar]: grapheme ? normalizeGrapheme(grapheme) : ''
    }));
  };

  const handleResetKey = () => {
    setKeyMap({});
    setDeriveWarning('');
    setDerivePlain('');
    setDeriveCipher('');
    setPlaygroundCipher('');
  };

  const handleAutoGuess = () => {
    const counts = {};
    segment(playgroundCipher).forEach((grapheme) => {
      if (isAsciiLetter(grapheme)) {
        const upper = grapheme.toUpperCase();
        counts[upper] = (counts[upper] || 0) + 1;
      }
    });
    const sorted = Object.keys(counts).sort(
      (a, b) => counts[b] - counts[a] || a.localeCompare(b)
    );
    setKeyMap((prev) => {
      // Latin-alphabet heuristic: replace ASCII-letter entries with the
      // frequency guesses, keep any CJK/emoji mappings untouched.
      const next = {};
      Object.entries(prev).forEach(([cipherChar, plainChar]) => {
        if (!isAsciiLetter(cipherChar)) next[cipherChar] = plainChar;
      });
      sorted.forEach((cipherChar, i) => {
        if (i < ENGLISH_FREQUENCY_ORDER.length) {
          next[cipherChar] = ENGLISH_FREQUENCY_ORDER[i];
        }
      });
      return next;
    });
  };

  const handleCopy = async (which, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Distinct ciphertext graphemes currently known: union of both ciphertext
  // inputs plus any already-mapped key entries, in first-seen order.
  const knownCipherChars = (() => {
    const seen = new Set();
    const list = [];
    const add = (grapheme) => {
      if (!grapheme.trim()) return;
      const key = normalizeGrapheme(grapheme);
      if (!seen.has(key)) {
        seen.add(key);
        list.push(key);
      }
    };
    segment(deriveCipher).forEach(add);
    segment(playgroundCipher).forEach(add);
    Object.entries(keyMap).forEach(([cipherChar, plainChar]) => {
      if (plainChar) add(cipherChar);
    });
    return list;
  })();

  // Key grid ordering: first-seen order by default, or sorted by cipher
  // character / currently mapped plaintext target. localeCompare handles
  // non-Latin graphemes correctly; empty targets sort first in 'plain' mode.
  const sortedCipherChars = (() => {
    if (keySort === 'cipher') {
      return [...knownCipherChars].sort((a, b) => a.localeCompare(b));
    }
    if (keySort === 'plain') {
      return [...knownCipherChars].sort((a, b) =>
        (keyMap[a] || '').localeCompare(keyMap[b] || '')
      );
    }
    return knownCipherChars;
  })();

  // Plaintext characters assigned to more than one ciphertext character -
  // not a valid bijective substitution, so highlight (but don't block).
  const duplicateTargets = (() => {
    const counts = {};
    Object.values(keyMap).forEach((plainChar) => {
      if (plainChar) counts[plainChar] = (counts[plainChar] || 0) + 1;
    });
    return new Set(Object.keys(counts).filter((plainChar) => counts[plainChar] > 1));
  })();

  // Live playground output, derived inline on every render - no manual sync.
  const decodedText = applyKey(playgroundCipher, keyMap);
  const encryptedText = applyKey(playgroundPlain, invertKey(keyMap));

  // Ciphertext character frequency (grapheme-based, whitespace excluded).
  const frequencyEntries = (() => {
    const counts = new Map();
    segment(playgroundCipher).forEach((grapheme) => {
      if (!grapheme.trim()) return;
      const key = normalizeGrapheme(grapheme);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  })();
  const maxFrequency = frequencyEntries.length > 0 ? frequencyEntries[0][1] : 0;

  const textareaClass =
    'w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none';

  const copyButton = (which, text) => (
    <button
      onClick={() => handleCopy(which, text)}
      disabled={!text}
      className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {copied === which ? (
        <>
          <Check size={12} />
          Copied!
        </>
      ) : (
        <>
          Copy
        </>
      )}
    </button>
  );

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <KeyRound size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Substitution Cipher
          </h3>
        </div>

        {/* Derive Key from Known Plaintext/Ciphertext */}
        <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
          <div className="text-sm font-medium text-os-text-primary">
            Derive Key from Known Plaintext/Ciphertext
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-os-text-primary mb-2">
                Plaintext
              </label>
              <textarea
                value={derivePlain}
                onChange={(e) => setDerivePlain(e.target.value)}
                placeholder="Known plaintext..."
                className={`${textareaClass} h-28`}
              />
            </div>
            <div>
              <label className="block text-sm text-os-text-primary mb-2">
                Ciphertext
              </label>
              <textarea
                value={deriveCipher}
                onChange={(e) => setDeriveCipher(e.target.value)}
                placeholder="Matching ciphertext..."
                className={`${textareaClass} h-28`}
              />
            </div>
          </div>
          <button
            onClick={handleDeriveKey}
            disabled={!derivePlain || !deriveCipher}
            className="btn btn-primary px-4 py-2 text-sm"
          >
            Derive Key
          </button>
          {deriveWarning && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
              {deriveWarning}
            </div>
          )}
        </div>

        {/* Key */}
        <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-medium text-os-text-primary">Key</div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-os-text-secondary">Sort:</span>
              <select
                value={keySort}
                onChange={(e) => setKeySort(e.target.value)}
                className="px-2 py-1.5 bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue text-xs"
              >
                <option value="appearance">Appearance</option>
                <option value="cipher">Cipher A→Z</option>
                <option value="plain">Plaintext A→Z</option>
              </select>
              <button
                onClick={handleAutoGuess}
                disabled={!playgroundCipher}
                className="btn btn-primary px-3 py-1.5 text-xs"
              >
                Auto-Guess by Frequency
              </button>
              <button
                onClick={handleResetKey}
                className="px-3 py-1.5 bg-os-card text-os-text-primary text-xs rounded-sm border border-os-border hover:bg-os-card-secondary transition-colors"
              >
                Reset Key
              </button>
            </div>
          </div>
          <div className="text-xs text-os-text-secondary">
            Ciphertext character → plaintext character. Duplicate targets are
            highlighted in red.
          </div>
          {knownCipherChars.length === 0 ? (
            <div className="text-sm text-os-text-secondary">
              No ciphertext characters yet - enter ciphertext above or in the
              playground below.
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
              {sortedCipherChars.map((cipherChar) => {
                const target = keyMap[cipherChar] || '';
                const isDuplicate = target && duplicateTargets.has(target);
                const distanceLabel = (() => {
                  if (!isAsciiLetter(cipherChar) || !isAsciiLetter(target)) return '';
                  const diff =
                    (target.charCodeAt(0) - cipherChar.charCodeAt(0) + 26) % 26;
                  const distance = diff > 13 ? diff - 26 : diff;
                  return distance > 0 ? `+${distance}` : String(distance);
                })();
                return (
                  <div
                    key={cipherChar}
                    className={`flex flex-col items-center justify-center px-2 py-1 rounded border ${
 isDuplicate
 ?'border-red-400 dark:border-red-700 bg-red-50 dark:bg-red-900/20'
 :'border-os-border'
 }`}
                  >
                    <span className="h-3 text-[10px] leading-3 text-os-text-muted text-center">
                      {distanceLabel}
                    </span>
                    <div className="flex items-center justify-center gap-1">
                      <span className="font-mono text-sm text-os-text-secondary min-w-5 text-center shrink-0">
                        {cipherChar}
                      </span>
                      <span className="text-xs text-os-text-muted shrink-0">→</span>
                      <input
                        value={target}
                        onChange={(e) => handleKeyEdit(cipherChar, e.target.value)}
                        onFocus={(e) => e.target.select()}
                        className="w-9 px-1 py-0.5 text-center bg-os-input-bg border border-os-input-border rounded-sm font-mono text-sm text-os-text-primary focus:outline-hidden focus:ring-1 focus:ring-os-blue"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Playground */}
        <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
          <div className="text-sm font-medium text-os-text-primary">Playground</div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Ciphertext to Decode
            </label>
            <textarea
              value={playgroundCipher}
              onChange={(e) => setPlaygroundCipher(e.target.value)}
              placeholder="Paste ciphertext - it decodes live as the key changes..."
              className={`${textareaClass} h-28`}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm text-os-text-primary">
                Decoded Text
              </label>
              {copyButton('decoded', decodedText)}
            </div>
            <textarea
              value={decodedText}
              readOnly
              placeholder="Decoded text will appear here..."
              className={`${textareaClass} h-28`}
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Plaintext to Encode
            </label>
            <textarea
              value={playgroundPlain}
              onChange={(e) => setPlaygroundPlain(e.target.value)}
              placeholder="Type plaintext to encrypt with the inverse key..."
              className={`${textareaClass} h-20`}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm text-os-text-primary">
                Encrypted Text
              </label>
              {copyButton('encrypted', encryptedText)}
            </div>
            <textarea
              value={encryptedText}
              readOnly
              placeholder="Encrypted text will appear here..."
              className={`${textareaClass} h-20`}
            />
          </div>
        </div>

        {/* Ciphertext Character Frequency */}
        <div className="p-4 bg-os-card border border-os-border rounded-sm">
          <div className="text-sm font-medium text-os-text-primary mb-3">
            Ciphertext Character Frequency
          </div>
          {frequencyEntries.length === 0 ? (
            <div className="text-sm text-os-text-secondary">
              Enter ciphertext in the playground to see character frequency
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {frequencyEntries.map(([grapheme, count]) => {
                const mapped = keyMap[grapheme];
                return (
                <div key={grapheme} className="flex items-center gap-3">
                  <div className="w-16 text-center text-os-text-primary text-sm font-mono shrink-0">
                    {grapheme}
                    {mapped && <span className="text-os-text-muted"> ({mapped})</span>}
                  </div>
                  <div className="w-14 text-right text-os-text-secondary text-sm shrink-0">
                    {count.toLocaleString()}
                  </div>
                  <div className="flex-1">
                    <div
                      className="h-2.5 bg-os-blue rounded-sm"
                      style={{ width: `${(count / maxFrequency) * 100}%` }}
                    />
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
