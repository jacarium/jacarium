import { useState } from 'react';
import { diffLines, diffWords } from 'diff';
import { Code } from 'lucide-react';

export default function TextDiffTool() {
  const [text1, setText1] = useState('');
  const [text2, setText2] = useState('');
  const [diffMode, setDiffMode] = useState('lines');

  const getDiff = () => {
    if (!text1 && !text2) return [];

    if (diffMode === 'lines') {
      return diffLines(text1, text2);
    } else {
      return diffWords(text1, text2);
    }
  };

  const diff = getDiff();

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Text Diff
          </h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Diff Mode</label>
          <select
            value={diffMode}
            onChange={(e) => setDiffMode(e.target.value)}
            className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          >
            <option value="lines">Line by Line</option>
            <option value="words">Word by Word</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Original Text</label>
            <textarea
              value={text1}
              onChange={(e) => setText1(e.target.value)}
              placeholder="Enter original text..."
              className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Modified Text</label>
            <textarea
              value={text2}
              onChange={(e) => setText2(e.target.value)}
              placeholder="Enter modified text..."
              className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Diff Output</label>
          <div className="p-4 bg-os-card border border-os-border rounded-sm overflow-auto max-h-96 font-mono text-sm min-h-[200px] whitespace-pre-wrap">
            {(text1 || text2) ? (
              diff.map((part, index) => {
                const bgColor = part.added
                  ? 'bg-green-100 dark:bg-green-900/30'
                  : part.removed
                  ? 'bg-red-100 dark:bg-red-900/30'
                  : '';
                const textColor = part.added
                  ? 'text-green-800 dark:text-green-300'
                  : part.removed
                  ? 'text-red-800 dark:text-red-300'
                  : 'text-os-text-primary';

                return (
                  <span
                    key={index}
                    className={`${bgColor} ${textColor}`}
                  >
                    {part.value}
                  </span>
                );
              })
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-os-text-secondary">
                Diff will appear here after entering text in both fields
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
