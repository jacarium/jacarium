import { useState, useRef, useEffect } from 'react';
import { Copy, Check, Table } from 'lucide-react';

/**
 * JsonToCsvTool - JSON to CSV converter
 *
 * Converts JSON array to CSV format
 */
export default function JsonToCsvTool() {
  const [jsonInput, setJsonInput] = useState('');
  const [csvOutput, setCsvOutput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  const [delimiter, setDelimiter] = useState(',');
  const [includeHeader, setIncludeHeader] = useState(true);
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

  const handleConvert = (value, currentDelimiter, currentIncludeHeader) => {
    try {
      if (!value || !value.trim()) {
        setCsvOutput('');
        setError('');
        return;
      }

      const data = JSON.parse(value);

      if (!Array.isArray(data)) {
        setError('JSON must be an array of objects');
        setCsvOutput('');
        return;
      }

      if (data.length === 0) {
        setError('JSON array is empty');
        setCsvOutput('');
        return;
      }

      // Get all unique keys from all objects
      const allKeys = [...new Set(data.flatMap(obj => Object.keys(obj)))];

      let csv = '';

      // Add header row
      if (currentIncludeHeader) {
        csv += allKeys.join(currentDelimiter) + '\n';
      }

      // Add data rows
      data.forEach(obj => {
        const values = allKeys.map(key => {
          const value = obj[key] !== undefined ? obj[key] : '';
          // Escape values containing delimiter or quotes
          const stringValue = String(value);
          if (stringValue.includes(currentDelimiter) || stringValue.includes('"') || stringValue.includes('\n')) {
            return '"' + stringValue.replace(/"/g, '""') + '"';
          }
          return stringValue;
        });
        csv += values.join(currentDelimiter) + '\n';
      });

      setCsvOutput(csv);
      setError('');
    } catch (err) {
      setError('Failed to convert: ' + err.message);
      setCsvOutput('');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(csvOutput);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const samples = [
    {
      name: 'Users Array',
      json: `[
  {"name": "John Doe", "email": "john@example.com", "age": 30},
  {"name": "Jane Smith", "email": "jane@example.com", "age": 25},
  {"name": "Bob Johnson", "email": "bob@example.com", "age": 35}
]`
    },
    {
      name: 'Products Array',
      json: `[
  {"id": 1, "product": "Laptop", "price": 999.99, "stock": 15},
  {"id": 2, "product": "Mouse", "price": 29.99, "stock": 50},
  {"id": 3, "product": "Keyboard", "price": 79.99, "stock": 30}
]`
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Table size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            JSON to CSV
          </h3>
        </div>

        {/* Settings */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <span className="text-sm text-os-text-primary">Delimiter:</span>
            <select
              value={delimiter}
              onChange={(e) => { setDelimiter(e.target.value); setTimeout(() => handleConvert(jsonInput, e.target.value, includeHeader), 0); }}
              className="px-2 py-1 bg-os-card border border-os-border rounded-sm text-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            >
              <option value=",">Comma (,)</option>
              <option value=";">Semicolon (;)</option>
              <option value="\t">Tab</option>
              <option value="|">Pipe (|)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeHeader}
              onChange={(e) => { setIncludeHeader(e.target.checked); setTimeout(() => handleConvert(jsonInput, delimiter, e.target.checked), 0); }}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Include header row</span>
          </label>
        </div>

        {/* JSON Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">
              JSON Input (array of objects)
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
                          setJsonInput(sample.json);
                          handleConvert(sample.json, delimiter, includeHeader);
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
            value={jsonInput}
            onChange={(e) => { setJsonInput(e.target.value); handleConvert(e.target.value, delimiter, includeHeader); }}
            placeholder={`[\n  {"name": "John", "age": 30, "city": "New York"},\n  {"name": "Jane", "age": 25, "city": "Los Angeles"}\n]`}
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* CSV Output */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-os-text-primary">
              CSV Output
            </label>
            {csvOutput && <button
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
            </button>}
          </div>
          {csvOutput ? (
            <textarea
              value={csvOutput}
              readOnly
              className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none"
            />
          ) : (
            <div className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              CSV output will appear here after entering JSON
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
