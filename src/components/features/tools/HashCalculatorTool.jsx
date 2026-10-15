import { useState } from 'react';
import { Copy, Check, Hash } from 'lucide-react';
import CryptoJS from 'crypto-js';

/**
 * HashCalculatorTool - Calculate various hash types
 *
 * Supports MD5, SHA1, SHA256, SHA384, SHA512
 */
export default function HashCalculatorTool() {
  const [input, setInput] = useState('');
  const [hashes, setHashes] = useState({});
  const [copied, setCopied] = useState(null);

  const calculateHashes = (text) => {
    if (!text) {
      setHashes({});
      return;
    }

    setHashes({
      md5: CryptoJS.MD5(text).toString(),
      sha1: CryptoJS.SHA1(text).toString(),
      sha256: CryptoJS.SHA256(text).toString(),
      sha384: CryptoJS.SHA384(text).toString(),
      sha512: CryptoJS.SHA512(text).toString()
    });
  };

  const handleInputChange = (value) => {
    setInput(value);
    calculateHashes(value);
  };

  const handleCopy = async (hashType, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(hashType);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const hashTypes = [
    { key: 'md5', label: 'MD5' },
    { key: 'sha1', label: 'SHA-1' },
    { key: 'sha256', label: 'SHA-256' },
    { key: 'sha384', label: 'SHA-384' },
    { key: 'sha512', label: 'SHA-512' }
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Hash size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Hash Calculator
          </h3>
        </div>

        <p className="text-sm text-os-text-secondary">
          Calculate various cryptographic hashes from text
        </p>

        {/* Input */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Input Text
          </label>
          <textarea
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="Enter text to hash..."
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
          />
        </div>

        {/* Hash Results */}
        <div className="space-y-3">
          <label className="block text-sm text-os-text-primary">
            Hash Results
          </label>
          {hashTypes.map(({ key, label }) => (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-os-text-secondary">
                  {label}
                </span>
                {hashes[key] && (
                  <button
                    onClick={() => handleCopy(key, hashes[key])}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === key ? (
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
              <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm font-mono text-xs text-os-text-primary break-all min-h-10 flex items-center">
                {hashes[key] || <span className="text-os-text-secondary">Hash will appear here...</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
