import { useState } from 'react';
import { Copy, Check, Sigma } from 'lucide-react';

// The only values of `a` coprime with 26, i.e. those with a modular inverse
const VALID_A_VALUES = [1, 3, 5, 7, 9, 11, 15, 17, 19, 21, 23, 25];

// Normalize any integer into the 0-25 range (handles negatives and >25)
const normalizeMod26 = (n) => ((n % 26) + 26) % 26;

// Modular inverse of `a` mod 26. Only called with values from VALID_A_VALUES,
// so an inverse always exists; a linear scan is cheap for a single lookup.
const modInverse = (a) => {
  for (let x = 1; x < 26; x++) {
    if ((a * x) % 26 === 1) return x;
  }
  return null;
};

const affineTransform = (text, a, b, mode) => {
  const aInv = modInverse(a);
  return Array.from(text)
    .map((char) => {
      const code = char.charCodeAt(0);
      let base = null;
      if (code >= 65 && code <= 90) base = 65;
      else if (code >= 97 && code <= 122) base = 97;
      if (base === null) return char;

      const x = code - base;
      const result =
        mode === 'encode'
          ? (a * x + b) % 26
          : normalizeMod26(aInv * (x - b));
      return String.fromCharCode(result + base);
    })
    .join('');
};

/**
 * AffineCipherTool - Affine cipher encoder/decoder tool
 *
 * Encodes with y = (a*x + b) mod 26 and decodes with x = a_inv*(y - b) mod 26.
 * `a` is constrained to values coprime with 26 so an inverse always exists.
 * Preserves case; non-letters pass through unchanged.
 */
export default function AffineCipherTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('encode'); // 'encode' or 'decode'
  const [keyA, setKeyA] = useState('5');
  const [keyB, setKeyB] = useState('8');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);

  const handleConvert = () => {
    const a = parseInt(keyA, 10);
    const b = parseInt(keyB, 10);
    if (Number.isNaN(b)) {
      setError('Key b must be an integer');
      setOutput('');
      return;
    }
    setError('');
    setOutput(affineTransform(input, a, normalizeMod26(b), mode));
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
    setError('');
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Sigma size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Affine Cipher
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

        {/* Keys */}
        <div className="flex items-end gap-4">
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Key a (coprime with 26)
            </label>
            <select
              value={keyA}
              onChange={(e) => setKeyA(e.target.value)}
              className="w-24 px-3 py-2 bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
            >
              {VALID_A_VALUES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Key b (0-25)
            </label>
            <input
              type="number"
              value={keyB}
              onChange={(e) => setKeyB(e.target.value)}
              className="w-24 px-3 py-2 bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
            />
          </div>
        </div>

        {/* Input */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Input
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'encode' ? 'Enter text to encode...' : 'Enter text to decode...'}
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={handleConvert}
            disabled={!input}
            className="btn btn-primary px-4 py-2 text-sm"
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

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
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
