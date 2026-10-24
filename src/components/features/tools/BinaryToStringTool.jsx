import { useState } from 'react';
import { Copy, Check, Binary } from 'lucide-react';

/**
 * BinaryToStringTool - Binary/text converter tool
 *
 * Converts space-separated binary octets to text and text to binary.
 * Uses TextEncoder/TextDecoder so multi-byte UTF-8 characters (accented
 * letters, CJK, emoji) round-trip correctly across multiple octets.
 */
export default function BinaryToStringTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('decode'); // 'decode' or 'encode'
  const [warning, setWarning] = useState('');
  const [copied, setCopied] = useState(null);

  const handleEncode = () => {
    const bytes = new TextEncoder().encode(input);
    const encoded = Array.from(bytes)
      .map((byte) => byte.toString(2).padStart(8, '0'))
      .join(' ');

    setOutput(encoded);
    setWarning('');
  };

  const handleDecode = () => {
    const invalid = new Set();
    const tokens = input.trim().split(/\s+/).filter(Boolean);

    const bytes = [];
    tokens.forEach((token) => {
      if (/^[01]{1,8}$/.test(token)) {
        bytes.push(parseInt(token, 2));
      } else {
        invalid.add(token);
      }
    });

    const decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));

    setOutput(decoded);
    setWarning(
      invalid.size > 0
        ? `Invalid binary token${invalid.size > 1 ? 's' : ''} skipped: ${[...invalid].join(' ')}`
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
          <Binary size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Binary to String
          </h3>
        </div>

        {/* Mode Toggle */}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="decode"
              checked={mode === 'decode'}
              onChange={(e) => setMode(e.target.value)}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Binary to String</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="encode"
              checked={mode === 'encode'}
              onChange={(e) => setMode(e.target.value)}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">String to Binary</span>
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
              mode === 'decode'
                ? 'Enter binary (e.g. 01001000 01101001)...'
                : 'Enter text to convert to binary...'
            }
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
            {mode === 'decode' ? 'Convert to Text' : 'Convert to Binary'}
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
