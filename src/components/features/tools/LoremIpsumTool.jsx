import { useState } from 'react';
import { FileText, Copy, Check } from 'lucide-react';

const loremWords = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
  'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
  'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum'
];

export default function LoremIpsumTool() {
  const [count, setCount] = useState(3);
  const [type, setType] = useState('paragraphs');
  const [output, setOutput] = useState('');
  const [copied, setCopied] = useState(null);

  const generateLorem = () => {
    let result = '';

    if (type === 'words') {
      const words = [];
      for (let i = 0; i < count; i++) {
        words.push(loremWords[Math.floor(Math.random() * loremWords.length)]);
      }
      result = words.join(' ') + '.';
      result = result.charAt(0).toUpperCase() + result.slice(1);
    } else if (type === 'sentences') {
      const sentences = [];
      for (let i = 0; i < count; i++) {
        const wordCount = Math.floor(Math.random() * 10) + 5;
        const words = [];
        for (let j = 0; j < wordCount; j++) {
          words.push(loremWords[Math.floor(Math.random() * loremWords.length)]);
        }
        let sentence = words.join(' ') + '.';
        sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
        sentences.push(sentence);
      }
      result = sentences.join(' ');
    } else {
      const paragraphs = [];
      for (let i = 0; i < count; i++) {
        const sentenceCount = Math.floor(Math.random() * 5) + 3;
        const sentences = [];
        for (let j = 0; j < sentenceCount; j++) {
          const wordCount = Math.floor(Math.random() * 10) + 5;
          const words = [];
          for (let k = 0; k < wordCount; k++) {
            words.push(loremWords[Math.floor(Math.random() * loremWords.length)]);
          }
          let sentence = words.join(' ') + '.';
          sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
          sentences.push(sentence);
        }
        paragraphs.push(sentences.join(' '));
      }
      result = paragraphs.join('\n\n');
    }

    setOutput(result);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Lorem Ipsum Generator
          </h3>
        </div>

        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm text-os-text-primary mb-2">Count</label>
            <input
              type="number"
              value={count}
              onChange={(e) => setCount(Math.max(1, parseInt(e.target.value) || 1))}
              min="1"
              max="100"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm text-os-text-primary mb-2">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            >
              <option value="paragraphs">Paragraphs</option>
              <option value="sentences">Sentences</option>
              <option value="words">Words</option>
            </select>
          </div>
          <button
            onClick={generateLorem}
            className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover transition-colors"
          >
            Generate
          </button>
        </div>
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">Output</label>
            {output && (
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
          <textarea
            value={output}
            readOnly
            placeholder="Lorem ipsum text will appear here after clicking 'Generate'..."
            className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm resize-none"
          />
        </div>
      </div>
    </div>
  );
}
