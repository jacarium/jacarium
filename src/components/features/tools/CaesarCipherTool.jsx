import { useState } from 'react';
import { Copy, Check, Shuffle } from 'lucide-react';

// Normalize any integer shift into the 0-25 range (handles negatives and >25)
const normalizeShift = (n) => ((n % 26) + 26) % 26;

const shiftText = (text, shift) => {
  const s = normalizeShift(shift);
  return Array.from(text)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code >= 65 && code <= 90) {
        return String.fromCharCode(((code - 65 + s) % 26) + 65);
      }
      if (code >= 97 && code <= 122) {
        return String.fromCharCode(((code - 97 + s) % 26) + 97);
      }
      return char;
    })
    .join('');
};

/**
 * CaesarCipherTool - Caesar cipher encoder/decoder tool
 *
 * Shifts letters by a user-supplied amount, preserving case and passing
 * non-letters through unchanged. Decoding shifts backward by the same amount.
 */
export default function CaesarCipherTool() {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('encode'); // 'encode' or 'decode'
  const [shift, setShift] = useState('3');
  const [copied, setCopied] = useState(null);

  const parsed = parseInt(shift, 10);
  const error = Number.isNaN(parsed) ? 'Shift must be an integer' : '';
  const output = error ? '' : shiftText(input, mode === 'encode' ? parsed : -parsed);

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
    setShift('3');
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Shuffle size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Caesar Cipher
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

        {/* Shift */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Shift
          </label>
          <input
            type="number"
            value={shift}
            onChange={(e) => setShift(e.target.value)}
            className="w-24 px-3 py-2 bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
          />
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
