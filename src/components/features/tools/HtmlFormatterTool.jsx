import { useState, useRef, useEffect } from 'react';
import prettier from 'prettier/standalone';
import parserHtml from 'prettier/parser-html';
import { Code } from 'lucide-react';

export default function HtmlFormatterTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
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

  const handleFormat = async (value) => {
    if (!value || !value.trim()) {
      setOutput('');
      setError('');
      return;
    }

    try {
      const formatted = await prettier.format(value, {
        parser: 'html',
        plugins: [parserHtml],
        tabWidth: 4,
        useTabs: false,
        htmlWhitespaceSensitivity: 'css'
      });
      setOutput(formatted);
      setError('');
    } catch (err) {
      setError('Invalid HTML: ' + err.message);
      setOutput('');
    }
  };

  const samples = [
    {
      name: 'Form',
      html: `<form><div class="form-group"><label for="name">Name:</label><input type="text" id="name" name="name" required></div><div class="form-group"><label for="email">Email:</label><input type="email" id="email" name="email" required></div><button type="submit">Submit</button></form>`
    },
    {
      name: 'Card Component',
      html: `<div class="card"><div class="card-header"><h2>Product Title</h2></div><div class="card-body"><p>Product description goes here. This is a sample card component.</p></div><div class="card-footer"><button class="btn">Buy Now</button></div></div>`
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            HTML Formatter
          </h3>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">HTML Input</label>
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
                          setInput(sample.html);
                          handleFormat(sample.html);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.html.substring(0, 50)}...</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea value={input} onChange={(e) => { setInput(e.target.value); handleFormat(e.target.value); }} placeholder="<div><h1>Hello</h1></div>" className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue placeholder:text-os-text-muted" />
        </div>
        {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Formatted HTML</label>
          {output ? (
            <textarea value={output} readOnly className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none" />
          ) : (
            <div className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              Formatted HTML will appear here after entering HTML
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
