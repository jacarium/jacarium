import { useState, useRef, useEffect } from 'react';
import { Link } from 'lucide-react';

/**
 * UrlEncoderTool - URL encoder/decoder
 *
 * Encode and decode URLs
 */
export default function UrlEncoderTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('encode'); // 'encode' or 'decode'
  const [preserveSpecialChars, setPreserveSpecialChars] = useState(true);
  const [error, setError] = useState('');
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

  const handleConvert = (inputValue, currentMode, preserveChars) => {
    const valueToConvert = inputValue !== undefined ? inputValue : input;
    const modeToUse = currentMode !== undefined ? currentMode : mode;
    const preserveToUse = preserveChars !== undefined ? preserveChars : preserveSpecialChars;

    if (!valueToConvert || !valueToConvert.trim()) {
      setOutput('');
      setError('');
      return;
    }

    try {
      if (modeToUse === 'encode') {
        const encoded = preserveToUse ? encodeURI(valueToConvert) : encodeURIComponent(valueToConvert);
        setOutput(encoded);
        setError('');
      } else {
        const decoded = decodeURIComponent(valueToConvert);
        setOutput(decoded);
        setError('');
      }
    } catch (err) {
      setError(modeToUse === 'encode' ? 'Failed to encode: ' + err.message : 'Failed to decode: Invalid URL encoding');
      setOutput('');
    }
  };

  const samples = [
    {
      name: 'URL with Query Parameters',
      decoded: 'https://example.com/search?q=hello world&filter=active',
      encoded: 'https://example.com/search?q=hello%20world&filter=active'
    },
    {
      name: 'URL with Special Characters',
      decoded: 'https://example.com/path?name=John Doe&email=user@example.com',
      encoded: 'https://example.com/path?name=John%20Doe&email=user@example.com'
    },
    {
      name: 'URL with Symbols',
      decoded: 'https://api.example.com/data?filter[status]=active&sort=-created_at',
      encoded: 'https://api.example.com/data?filter[status]=active&sort=-created_at'
    },
    {
      name: 'URL with Spaces and Punctuation',
      decoded: 'https://example.com/article?title=Hello, World! How are you?',
      encoded: 'https://example.com/article?title=Hello,%20World!%20How%20are%20you?'
    },
    {
      name: 'Encoded Email Address',
      decoded: 'user+test@example.com',
      encoded: 'user+test@example.com'
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            URL
          </h3>
        </div>

        {/* Mode Toggle */}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="encode"
              checked={mode === 'encode'}
              onChange={(e) => { setMode(e.target.value); handleConvert(input, e.target.value, preserveSpecialChars); }}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Encode</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="decode"
              checked={mode === 'decode'}
              onChange={(e) => { setMode(e.target.value); handleConvert(input, e.target.value, preserveSpecialChars); }}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Decode</span>
          </label>
        </div>

        {/* Encode Options */}
        {mode === 'encode' && (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={preserveSpecialChars}
                onChange={(e) => { setPreserveSpecialChars(e.target.checked); handleConvert(input, mode, e.target.checked); }}
                className="text-os-blue focus:ring-os-blue"
              />
              <span className="text-sm text-os-text-primary">Preserve URL structure characters (: / ? # [ ] @ ! $ &amp; ' ( ) * + , ; =)</span>
            </label>
          </div>
        )}

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
                            setInput(sample.decoded);
                          } else {
                            setInput(sample.encoded);
                          }
                          setShowSamples(false);
                          handleConvert(mode === 'encode' ? sample.decoded : sample.encoded, mode, preserveSpecialChars);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">
                            {mode === 'encode' ? sample.decoded : sample.encoded}
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
            onChange={(e) => { setInput(e.target.value); handleConvert(e.target.value, mode, preserveSpecialChars); }}
            placeholder={mode === 'encode' ? 'Enter URL to encode...' : 'Enter encoded URL to decode...'}
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Output */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Output
          </label>
          {output ? (
            <textarea
              value={output}
              readOnly
              className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none"
            />
          ) : (
            <div className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              Output will appear here after entering {mode === 'encode' ? 'URL to encode' : 'encoded URL'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
