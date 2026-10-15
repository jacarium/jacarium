import { useState } from 'react';
import { Type } from 'lucide-react';

export default function StringAnalyzerTool() {
  const [input, setInput] = useState('');

  const analyze = () => {
    if (!input) {
      return {
        characters: 0,
        charactersNoSpaces: 0,
        words: 0,
        lines: 0,
        sentences: 0,
        paragraphs: 0,
        bytes: 0
      };
    }

    const characters = input.length;
    const charactersNoSpaces = input.replace(/\s/g, '').length;
    const words = input.trim() ? input.trim().split(/\s+/).length : 0;
    const lines = input.split('\n').length;
    const sentences = input.split(/[.!?]+/).filter(s => s.trim()).length;
    const paragraphs = input.split(/\n\s*\n/).filter(p => p.trim()).length;
    const bytes = new Blob([input]).size;

    return {
      characters,
      charactersNoSpaces,
      words,
      lines,
      sentences,
      paragraphs,
      bytes
    };
  };

  const stats = analyze();

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Type size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            String Analyzer
          </h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Input Text</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter text to analyze..."
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Characters</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{stats.characters.toLocaleString()}</div>
          </div>
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Characters (no spaces)</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{stats.charactersNoSpaces.toLocaleString()}</div>
          </div>
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Words</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{stats.words.toLocaleString()}</div>
          </div>
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Lines</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{stats.lines.toLocaleString()}</div>
          </div>
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Sentences</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{stats.sentences.toLocaleString()}</div>
          </div>
          <div className="p-4 bg-os-card border border-os-border rounded-sm">
            <div className="text-sm text-os-text-secondary">Paragraphs</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{stats.paragraphs.toLocaleString()}</div>
          </div>
          <div className="p-4 bg-os-card border border-os-border rounded-sm col-span-2">
            <div className="text-sm text-os-text-secondary">Size</div>
            <div className="text-2xl font-bold text-os-text-primary mt-1">{stats.bytes.toLocaleString()} bytes</div>
          </div>
        </div>
      </div>
    </div>
  );
}
