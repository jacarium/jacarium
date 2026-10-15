import { useState } from 'react';
import { BarChart2 } from 'lucide-react';

export default function HistogramTool() {
  const [input, setInput] = useState('');

  const analyze = () => {
    if (!input) {
      return {
        total: 0,
        unique: 0,
        entries: []
      };
    }

    // Segment into user-perceived characters (grapheme clusters) so emoji
    // (including ZWJ sequences and flags) and CJK characters are counted as
    // single glyphs instead of broken UTF-16 surrogate halves.
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const counts = new Map();
    let total = 0;

    for (const { segment } of segmenter.segment(input)) {
      total += 1;
      counts.set(segment, (counts.get(segment) || 0) + 1);
    }

    const entries = [...counts.entries()]
      .filter(([char]) => char.trim().length > 0)
      .sort((a, b) => b[1] - a[1]);

    return {
      total,
      unique: counts.size,
      entries
    };
  };

  const { total, unique, entries } = analyze();
  const maxCount = entries.length > 0 ? entries[0][1] : 0;

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <BarChart2 size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Histogram
          </h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Input Text</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter text to generate a character histogram... (supports emoji, 日本語, 한국어, 中文)"
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Total Characters</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{total.toLocaleString()}</div>
          </div>
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Unique Characters</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{unique.toLocaleString()}</div>
          </div>
        </div>

        {/* Histogram bars */}
        <div className="p-4 bg-os-card border border-os-border rounded-sm">
          <div className="text-sm text-os-text-secondary mb-3">Character Frequency</div>
          {entries.length === 0 ? (
            <div className="text-sm text-os-text-secondary">No characters to display</div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {entries.map(([char, count]) => (
                <div key={char} className="flex items-center gap-3">
                  <div className="w-10 text-center text-os-text-primary text-sm shrink-0">{char}</div>
                  <div className="w-14 text-right text-os-text-secondary text-sm shrink-0">{count.toLocaleString()}</div>
                  <div className="flex-1">
                    <div
                      className="h-2.5 bg-os-blue rounded-sm"
                      style={{ width: `${(count / maxCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
