import { useState, useRef, useEffect } from 'react';
import { Copy, Check, FileJson, List } from 'lucide-react';

/**
 * CsvToJsonTool - CSV to JSON converter
 *
 * Converts CSV data to JSON format
 */
export default function CsvToJsonTool() {
  const [csvInput, setCsvInput] = useState('');
  const [jsonOutput, setJsonOutput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeader, setHasHeader] = useState(true);
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

  // Parse a CSV line properly handling quoted fields
  const parseCsvLine = (line, delimiter) => {
    const values = [];
    let currentValue = '';
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote inside quoted field
          currentValue += '"';
          i += 2;
          continue;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
          i++;
          continue;
        }
      }

      if (char === delimiter && !inQuotes) {
        // End of field
        values.push(currentValue.trim());
        currentValue = '';
        i++;
        continue;
      }

      currentValue += char;
      i++;
    }

    // Add the last field
    values.push(currentValue.trim());

    return values;
  };

  const handleConvert = (value, currentDelimiter, currentHasHeader) => {
    try {
      if (!value || !value.trim()) {
        setJsonOutput('');
        setError('');
        return;
      }

      const lines = value.trim().split('\n');
      if (lines.length === 0) {
        setError('No data to convert');
        setJsonOutput('');
        return;
      }

      let headers;
      let dataLines;

      if (currentHasHeader) {
        headers = parseCsvLine(lines[0], currentDelimiter);
        dataLines = lines.slice(1);
      } else {
        const firstLine = parseCsvLine(lines[0], currentDelimiter);
        headers = firstLine.map((_, i) => `column${i + 1}`);
        dataLines = lines;
      }

      const jsonData = dataLines
        .filter(line => line.trim())
        .map(line => {
          const values = parseCsvLine(line, currentDelimiter);
          const obj = {};
          headers.forEach((header, index) => {
            obj[header] = values[index] || '';
          });
          return obj;
        });

      setJsonOutput(JSON.stringify(jsonData, null, 2));
      setError('');
    } catch (err) {
      setError('Failed to convert: ' + err.message);
      setJsonOutput('');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonOutput);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const samples = [
    {
      name: 'Users List',
      csv: `name,email,age,city
John Doe,john@example.com,30,New York
Jane Smith,jane@example.com,25,Los Angeles
Bob Johnson,bob@example.com,35,Chicago`
    },
    {
      name: 'Products',
      csv: `id,product,price,stock
1,Laptop,999.99,15
2,Mouse,29.99,50
3,Keyboard,79.99,30`
    },
    {
      name: 'Sales Data',
      csv: `date,product,quantity,revenue
2024-01-15,Widget A,100,5000
2024-01-16,Widget B,75,3750
2024-01-17,Widget A,120,6000`
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <FileJson size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            CSV to JSON
          </h3>
        </div>

        {/* Settings */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <span className="text-sm text-os-text-primary">Delimiter:</span>
            <select
              value={delimiter}
              onChange={(e) => { setDelimiter(e.target.value); setTimeout(() => handleConvert(csvInput, e.target.value, hasHeader), 0); }}
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
              checked={hasHeader}
              onChange={(e) => { setHasHeader(e.target.checked); setTimeout(() => handleConvert(csvInput, delimiter, e.target.checked), 0); }}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">First row is header</span>
          </label>
        </div>

        {/* CSV Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">
              CSV Input
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
                          setCsvInput(sample.csv);
                          handleConvert(sample.csv, delimiter, hasHeader);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.csv.split('\n')[0]}</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea
            value={csvInput}
            onChange={(e) => { setCsvInput(e.target.value); handleConvert(e.target.value, delimiter, hasHeader); }}
            placeholder={`name,age,city\nJohn,30,New York\nJane,25,Los Angeles`}
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* JSON Output */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-os-text-primary">
              JSON Output
            </label>
            {jsonOutput && <button
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
          {jsonOutput ? (
            <textarea
              value={jsonOutput}
              readOnly
              className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none"
            />
          ) : (
            <div className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              JSON output will appear here after entering CSV
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
