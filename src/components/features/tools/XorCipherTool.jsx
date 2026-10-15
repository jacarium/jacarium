import { useState } from 'react';
import { Copy, Check, Blend } from 'lucide-react';

const HEX_RE = /^[0-9a-fA-F]+$/;

// Parse the key into bytes according to the chosen format.
// Returns { bytes } on success or { error } on invalid input.
const parseKeyBytes = (key, format) => {
  if (!key) {
    return { error: 'Key is required - XOR with an empty key is meaningless' };
  }
  if (format === 'hex') {
    const cleaned = key.trim();
    if (cleaned.length % 2 !== 0 || !HEX_RE.test(cleaned)) {
      return { error: 'Key must be a valid even-length hex string (e.g. 2a1f)' };
    }
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    return { bytes };
  }
  return { bytes: new TextEncoder().encode(key) };
};

// Repeating-key XOR: each byte is XORed with the key byte at (index mod keyLength)
const xorBytes = (bytes, keyBytes) => {
  const result = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return result;
};

const bytesToHex = (bytes) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * XorCipherTool - Repeating-key XOR cipher encoder/decoder tool
 *
 * Encode: plain text -> UTF-8 bytes XOR key -> lowercase hex string.
 * Decode: hex ciphertext -> bytes XOR key -> UTF-8 text.
 * Hex is used for ciphertext because XOR output bytes are usually not
 * valid/printable text. The key can be given as text (UTF-8 bytes) or hex.
 */
export default function XorCipherTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('encode'); // 'encode' or 'decode'
  const [cipherKey, setCipherKey] = useState('');
  const [keyFormat, setKeyFormat] = useState('text'); // 'text' or 'hex'
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);

  const handleConvert = () => {
    const { bytes: keyBytes, error: keyError } = parseKeyBytes(cipherKey, keyFormat);
    if (keyError) {
      setError(keyError);
      setOutput('');
      return;
    }

    if (mode === 'encode') {
      const inputBytes = new TextEncoder().encode(input);
      setOutput(bytesToHex(xorBytes(inputBytes, keyBytes)));
      setError('');
      return;
    }

    const cleaned = input.trim();
    if (cleaned.length % 2 !== 0 || !HEX_RE.test(cleaned)) {
      setError('Input must be a valid even-length hex string (e.g. 4f6c1a)');
      setOutput('');
      return;
    }
    const cipherBytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < cipherBytes.length; i++) {
      cipherBytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    // Non-fatal decode: a wrong key yields garbled text, not a crash
    setOutput(new TextDecoder('utf-8').decode(xorBytes(cipherBytes, keyBytes)));
    setError('');
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
          <Blend size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            XOR Cipher
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

        {/* Key */}
        <div className="flex items-end gap-4">
          <div className="flex-1 max-w-xs">
            <label className="block text-sm text-os-text-primary mb-2">
              Key
            </label>
            <input
              type="text"
              value={cipherKey}
              onChange={(e) => setCipherKey(e.target.value)}
              placeholder={keyFormat === 'hex' ? 'e.g. 2a1f' : 'e.g. secret'}
              className="w-full px-3 py-2 bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Key Format
            </label>
            <select
              value={keyFormat}
              onChange={(e) => setKeyFormat(e.target.value)}
              className="w-24 px-3 py-2 bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm"
            >
              <option value="text">Text</option>
              <option value="hex">Hex</option>
            </select>
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
            placeholder={
              mode === 'encode'
                ? 'Enter text to encode...'
                : 'Enter hex ciphertext to decode... (e.g. 4f6c1a)'
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
