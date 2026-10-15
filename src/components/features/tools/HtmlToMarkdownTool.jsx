import { useState, useRef, useEffect } from 'react';
import TurndownService from 'turndown';
import { Copy, Check, Code } from 'lucide-react';

/**
 * HtmlToMarkdownTool - HTML to Markdown converter
 */
export default function HtmlToMarkdownTool() {
  const [html, setHtml] = useState('');
  const [markdown, setMarkdown] = useState('');
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

  const turndownService = new TurndownService({
    headingStyle: 'atx', // Use # style headers instead of underlined
    codeBlockStyle: 'fenced', // Use ``` style code blocks
    bulletListMarker: '-' // Use - for bullet lists
  });

  const handleConvert = (value) => {
    if (!value || !value.trim()) {
      setMarkdown('');
      return;
    }

    try {
      const result = turndownService.turndown(value);
      setMarkdown(result);
    } catch (err) {
      console.error('Conversion error:', err);
      setMarkdown('');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const samples = [
    {
      name: 'Article',
      html: `<h1>Getting Started with HTML</h1>
<p>HTML is the standard markup language for creating web pages. It describes the structure of a web page.</p>
<h2>Basic Structure</h2>
<ul>
  <li>Headings</li>
  <li>Paragraphs</li>
  <li>Links</li>
</ul>
<p>For more info, visit <a href="https://example.com">example.com</a>.</p>`
    },
    {
      name: 'Code Block',
      html: `<h2>JavaScript Example</h2>
<p>Here's a simple function:</p>
<pre><code>function greet(name) {
  return "Hello, " + name;
}</code></pre>
<p>This function takes a <strong>name</strong> and returns a greeting.</p>`
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            HTML to Markdown
          </h3>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">
              HTML Input
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
                          setHtml(sample.html);
                          handleConvert(sample.html);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.html.split('\n')[0]}</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea
            value={html}
            onChange={(e) => { setHtml(e.target.value); handleConvert(e.target.value); }}
            placeholder="<h1>Hello</h1>"
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm resize-none"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-os-text-primary">
              Markdown Output
            </label>
            {markdown && (
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
          {markdown ? (
            <textarea
              value={markdown}
              readOnly
              className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none"
            />
          ) : (
            <div className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              Markdown output will appear here after conversion
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
