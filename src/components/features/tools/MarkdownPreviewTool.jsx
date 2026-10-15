import { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { marked } from 'marked';

/**
 * MarkdownPreviewTool - Markdown previewer
 *
 * Live preview of markdown rendering with HTML output
 */
export default function MarkdownPreviewTool() {
  const [markdown, setMarkdown] = useState('# Hello World\n\nStart typing markdown here...\n\n## Features\n\n- **Bold text**\n- *Italic text*\n- `Code`\n- [Links](https://example.com)\n\n```javascript\nconst hello = "world";\n```');

  // Convert markdown to HTML
  const htmlOutput = useMemo(() => {
    try {
      // Configure marked to output clean HTML without any modifications
      marked.setOptions({
        breaks: false,
        gfm: true,
        headerIds: true,
        mangle: false,
        sanitize: false
      });

      const html = marked(markdown);

      // Remove any onclick handlers or electron-specific code that might have been added
      // Parse the HTML and clean it
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Remove all onclick attributes
      const elementsWithOnclick = doc.querySelectorAll('[onclick]');
      elementsWithOnclick.forEach(el => {
        el.removeAttribute('onclick');
      });

      return doc.body.innerHTML;
    } catch {
      return '<p>Error converting markdown to HTML</p>';
    }
  }, [markdown]);

  return (
    <div className="h-full flex bg-os-background">
      {/* Editor - Full height, no header */}
      <div className="w-1/2 border-r border-os-border flex">
        <textarea
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          placeholder="Enter markdown..."
          className="w-full h-full px-3 py-2 bg-os-card border-0 text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-0 font-mono text-sm resize-none"
        />
      </div>

      {/* Preview - Split into rendered and HTML */}
      <div className="w-1/2 flex flex-col">
        {/* Rendered Preview */}
        <div className="flex-1 p-6 overflow-auto border-b border-os-border">
          <h3 className="text-sm font-semibold text-os-text-secondary mb-4 uppercase tracking-wide">
            Preview
          </h3>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{markdown}</ReactMarkdown>
          </div>
        </div>

        {/* HTML Output */}
        <div className="flex-1 p-6 overflow-auto bg-os-card-secondary">
          <h3 className="text-sm font-semibold text-os-text-secondary mb-4 uppercase tracking-wide">
            HTML Output
          </h3>
          <pre className="text-xs font-mono text-os-text-primary whitespace-pre-wrap wrap-break-word">
            {htmlOutput}
          </pre>
        </div>
      </div>
    </div>
  );
}
