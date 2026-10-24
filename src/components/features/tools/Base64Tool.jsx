import { useState, useRef, useEffect } from 'react';
import { Copy, Check, Code } from 'lucide-react';

/**
 * Base64Tool - Base64 encoder/decoder tool
 *
 * Allows users to encode and decode Base64 strings
 */
export default function Base64Tool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('encode'); // 'encode' or 'decode'
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  const [showSamples, setShowSamples] = useState(false);
  const samplesRef = useRef(null);

  // Close samples dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (samplesRef.current && !samplesRef.current.contains(event.target)) {
        setShowSamples(false);
      }
    };

    if (showSamples) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSamples]);

  const handleEncode = () => {
    try {
      const encoded = btoa(input);
      setOutput(encoded);
      setError('');
    } catch (err) {
      setError('Failed to encode: ' + err.message);
      setOutput('');
    }
  };

  const handleDecode = () => {
    try {
      const decoded = atob(input);
      setOutput(decoded);
      setError('');
    } catch {
      setError('Failed to decode: Invalid Base64 string');
      setOutput('');
    }
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
    setError('');
  };

  const samples = [
    { name: 'Simple Text', text: 'Hello, World!', encoded: 'SGVsbG8sIFdvcmxkIQ==' },
    { name: 'Email', text: 'user@example.com', encoded: 'dXNlckBleGFtcGxlLmNvbQ==' },
    { name: 'JSON', text: '{"name":"John","age":30}', encoded: 'eyJuYW1lIjoiSm9obiIsImFnZSI6MzB9' },
    { name: 'API Key', text: 'sk_test_1234567890abcdef', encoded: 'c2tfdGVzdF8xMjM0NTY3ODkwYWJjZGVm' },
    { name: 'URL', text: 'https://example.com/api?key=value', encoded: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9hcGk/a2V5PXZhbHVl' },
    { name: 'Special Characters', text: '!@#$%^&*()_+-=[]{}|;:,.<>?', encoded: 'IUAjJCVeJiooKV8rLT1bXXt9fDssOywuPD4/' },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Base64
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
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">
              Input
            </label>
            <div className="relative" ref={samplesRef}>
              <button
                onClick={() => setShowSamples(!showSamples)}
                className="flex items-center gap-1 px-3 py-1 text-xs text-os-text-secondary hover:text-os-text-primary bg-os-card border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors"
              >
                Samples
              </button>
              {showSamples && (
                <div className="absolute right-0 top-full mt-1 w-80 bg-os-card border border-os-border rounded-sm shadow-lg z-10 max-h-96 overflow-auto">
                  <div className="p-1">
                    {samples.map((sample, index) => (
                      <button
                        key={index}
                        onClick={() => {
                          if (mode === 'encode') {
                            setInput(sample.text);
                          } else {
                            setInput(sample.encoded);
                          }
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">
                            {mode === 'encode' ? sample.text : sample.encoded}
                          </code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'encode' ? 'Enter text to encode...' : 'Enter Base64 to decode...'}
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
