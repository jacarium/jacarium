import { useState } from 'react';
import { Copy, Check, Radio } from 'lucide-react';

// International Morse code map: A-Z, 0-9, and common punctuation
const MORSE_MAP = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.',
  '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.',
  $: '...-..-', '@': '.--.-.'
};

const REVERSE_MORSE_MAP = Object.fromEntries(
  Object.entries(MORSE_MAP).map(([char, code]) => [code, char])
);

/**
 * MorseCodeTool - Morse code encoder/decoder tool
 *
 * Encodes plain text to International Morse code and decodes it back.
 * Letters are separated by a single space, words by " / ".
 */
export default function MorseCodeTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('encode'); // 'encode' or 'decode'
  const [warning, setWarning] = useState('');
  const [copied, setCopied] = useState(null);

  const handleEncode = () => {
    const unsupported = new Set();
    const words = input.trim().split(/\s+/).filter(Boolean);

    const encoded = words
      .map((word) =>
        Array.from(word.toUpperCase())
          .map((char) => {
            const code = MORSE_MAP[char];
            if (!code) {
              unsupported.add(char);
              return null;
            }
            return code;
          })
          .filter(Boolean)
          .join(' ')
      )
      .filter(Boolean)
      .join(' / ');

    setOutput(encoded);
    setWarning(
      unsupported.size > 0
        ? `Unsupported character${unsupported.size > 1 ? 's' : ''} skipped: ${[...unsupported].join(' ')}`
        : ''
    );
  };

  const handleDecode = () => {
    const unknown = new Set();
    const words = input.trim().split(/\s+\/\s+|\s*\/\s*/).filter(Boolean);

    const decoded = words
      .map((word) =>
        word
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => {
            const char = REVERSE_MORSE_MAP[token];
            if (!char) {
              unknown.add(token);
              return null;
            }
            return char;
          })
          .filter(Boolean)
          .join('')
      )
      .filter(Boolean)
      .join(' ');

    setOutput(decoded);
    setWarning(
      unknown.size > 0
        ? `Unknown token${unknown.size > 1 ? 's' : ''} skipped: ${[...unknown].join(' ')}`
        : ''
    );
  };

  const handleConvert = () => {
    if (mode === 'encode') {
      handleEncode();
    } else {
      handleDecode();
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleClear = () => {
    setInput('');
    setOutput('');
    setWarning('');
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Radio size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Morse Code
          </h3>
        </div>

        {/* Mode Toggle */}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="encode"
              checked={mode === 'encode'}
              onChange={(e) => setMode(e.target.value)}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Encode</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="decode"
              checked={mode === 'decode'}
              onChange={(e) => setMode(e.target.value)}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Decode</span>
          </label>
        </div>

        {/* Input */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Input
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              mode === 'encode'
                ? 'Enter text to encode...'
                : 'Enter Morse code to decode... (use space between letters, / between words)'
            }
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleConvert}
            disabled={!input}
            className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {mode === 'encode' ? 'Encode' : 'Decode'}
          </button>
          <button
            onClick={handleClear}
            className="px-4 py-2 bg-os-card text-os-text-primary text-sm rounded-sm border border-os-border hover:bg-os-card-secondary transition-colors"
          >
            Clear
          </button>
        </div>

        {/* Warning */}
        {warning && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {warning}
          </div>
        )}

        {/* Output */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-os-text-primary">
              Output
            </label>
            {output && (
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
              >
                {copied === 'output' ? (
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
            )}
          </div>
          <textarea
            value={output}
            readOnly
            placeholder="Output will appear here..."
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none"
          />
        </div>
      </div>
    </div>
  );
}
