import { useState, useRef, useEffect } from 'react';
import yaml from 'js-yaml';
import { Copy, Check, FileJson } from 'lucide-react';

export default function JsonToYamlTool() {
  const [jsonInput, setJsonInput] = useState('');
  const [yamlOutput, setYamlOutput] = useState('');
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

  const handleConvert = (value) => {
    if (!value) {
      setYamlOutput('');
      setError('');
      return;
    }
    try {
      const parsed = JSON.parse(value);
      const yamlStr = yaml.dump(parsed);
      setYamlOutput(yamlStr);
      setError('');
    } catch (err) {
      setError('Invalid JSON: ' + err.message);
      setYamlOutput('');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(yamlOutput);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const samples = [
    {
      name: 'Configuration',
      json: '{"database":{"host":"localhost","port":5432,"credentials":{"username":"admin","password":"secret"}},"logging":{"level":"info","file":"/var/log/app.log"}}'
    },
    {
      name: 'Docker Compose',
      json: '{"version":"3.8","services":{"web":{"image":"nginx:latest","ports":["80:80"]},"db":{"image":"postgres:13","environment":["POSTGRES_PASSWORD=secret"]}}}'
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <FileJson size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            JSON to YAML
          </h3>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">JSON Input</label>
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
                          handleConvert(sample.json);
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
            onChange={(e) => { setJsonInput(e.target.value); handleConvert(e.target.value); }}
            placeholder='{"key": "value"}'
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-os-text-primary">YAML Output</label>
            {yamlOutput && <button onClick={handleCopy} className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors">
              {copied === 'output' ? <><Check size={12} />Copied!</> : <>Copy</>}
            </button>}
          </div>
          {yamlOutput ? (
            <textarea
              value={yamlOutput}
              readOnly
              className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none"
            />
          ) : (
            <div className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              YAML output will appear here after entering JSON
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
