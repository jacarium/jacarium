import { useState, useRef, useEffect } from 'react';
import { Copy, Check, FileText } from 'lucide-react';

/**
 * JsonFormatterTool - JSON formatter and validator
 *
 * Formats and validates JSON strings
 */
export default function JsonFormatterTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  const [indentSize, setIndentSize] = useState(2);
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

  const handleFormat = (value, currentIndent) => {
    const valueToFormat = value !== undefined ? value : input;
    const indentToUse = currentIndent !== undefined ? currentIndent : indentSize;

    if (!valueToFormat || !valueToFormat.trim()) {
      setOutput('');
      setError('');
      return;
    }

    try {
      const parsed = JSON.parse(valueToFormat);
      const formatted = JSON.stringify(parsed, null, indentToUse);
      setOutput(formatted);
      setError('');
    } catch (err) {
      setError('Invalid JSON: ' + err.message);
      setOutput('');
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

  const samples = [
    {
      name: 'User Object',
      json: '{"id":1,"name":"John Doe","email":"john@example.com","age":30,"isActive":true}'
    },
    {
      name: 'API Response',
      json: '{"status":"success","data":{"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}],"total":2},"timestamp":"2024-01-01T12:00:00Z"}'
    },
    {
      name: 'Configuration',
      json: '{"server":{"host":"localhost","port":8080,"ssl":false},"database":{"host":"db.example.com","port":5432,"name":"mydb"},"logging":{"level":"info","file":"/var/log/app.log"}}'
    },
    {
      name: 'Array of Objects',
      json: '[{"id":1,"product":"Laptop","price":999.99},{"id":2,"product":"Mouse","price":29.99},{"id":3,"product":"Keyboard","price":79.99}]'
    },
    {
      name: 'Nested Object',
      json: '{"company":{"name":"Tech Corp","address":{"street":"123 Main St","city":"San Francisco","state":"CA","zip":"94105"},"employees":[{"name":"Alice","role":"Engineer"},{"name":"Bob","role":"Designer"}]}}'
    },
    {
      name: 'Package.json',
      json: '{"name":"my-app","version":"1.0.0","description":"Sample application","main":"index.js","scripts":{"start":"node index.js","test":"jest"},"dependencies":{"express":"^4.18.0","lodash":"^4.17.21"},"devDependencies":{"jest":"^29.0.0"}}'
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            JSON Formatter
          </h3>
        </div>

        {/* Settings */}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="text-sm text-os-text-primary">Indent size:</span>
            <select
              value={indentSize}
              onChange={(e) => { setIndentSize(Number(e.target.value)); handleFormat(input, Number(e.target.value)); }}
              className="px-2 py-1 bg-os-card border border-os-border rounded-sm text-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            >
              <option value={2}>2 spaces</option>
              <option value={4}>4 spaces</option>
              <option value={8}>8 spaces</option>
            </select>
          </label>
        </div>

        {/* Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">
              Input JSON
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
                          setInput(sample.json);
                          handleFormat(sample.json, indentSize);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.json.substring(0, 50)}...</code>
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
            onChange={(e) => { setInput(e.target.value); handleFormat(e.target.value, indentSize); }}
            placeholder='{"key": "value"}'
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
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
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">Formatted JSON</label>
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
          {output ? (
            <pre className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm overflow-auto max-h-96">
              {output}
            </pre>
          ) : (
            <div className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary min-h-[200px]">
              Formatted JSON will appear here after entering JSON
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
