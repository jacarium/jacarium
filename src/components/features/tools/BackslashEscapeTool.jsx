import { useState, useRef, useEffect } from 'react';
import { Code } from 'lucide-react';

export default function BackslashEscapeTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('escape');
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

  const handleEscape = () => {
    setOutput(input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
  };

  const handleUnescape = () => {
    try {
      setOutput(input.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    } catch (err) {
      console.error(err);
    }
  };

  const handleConvert = () => mode === 'escape' ? handleEscape() : handleUnescape();

  const samples = [
    {
      name: 'JSON String',
      escaped: 'He said, \\"Hello World\\"',
      unescaped: 'He said, "Hello World"'
    },
    {
      name: 'File Path',
      escaped: 'C:\\\\Users\\\\Documents\\\\file.txt',
      unescaped: 'C:\\Users\\Documents\\file.txt'
    },
    {
      name: 'Multi-line Text',
      escaped: 'Line 1\\nLine 2\\nLine 3',
      unescaped: 'Line 1\nLine 2\nLine 3'
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Backslash Escape/Unescape
          </h3>
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" value="escape" checked={mode === 'escape'} onChange={(e) => setMode(e.target.value)} className="text-os-blue" />
            <span className="text-sm text-os-text-primary">Escape</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" value="unescape" checked={mode === 'unescape'} onChange={(e) => setMode(e.target.value)} className="text-os-blue" />
            <span className="text-sm text-os-text-primary">Unescape</span>
          </label>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">Input</label>
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
                          setInput(mode === 'escape' ? sample.unescaped : sample.escaped);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">
                            {mode === 'escape' ? sample.unescaped : sample.escaped}
                          </code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Enter text..." className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue placeholder:text-os-text-muted" />
        </div>
        <button onClick={handleConvert} disabled={!input} className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover disabled:opacity-50 transition-colors">{mode === 'escape' ? 'Escape' : 'Unescape'}</button>
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Output</label>
          <textarea value={output} readOnly placeholder="Output will appear here..." className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none placeholder:text-os-text-muted" />
        </div>
      </div>
    </div>
  );
}
