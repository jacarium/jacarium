import { useState } from 'react';
import { Copy, Check, Hash } from 'lucide-react';
import { generateUUID } from '../../../utils/uuid';

/**
 * UuidGeneratorTool - UUID generator
 *
 * Generates UUIDs (v4)
 */
export default function UuidGeneratorTool() {
  const [uuids, setUuids] = useState([]);
  const [count, setCount] = useState(1);
  const [uppercase, setUppercase] = useState(false);
  const [copied, setCopied] = useState(null);

  const handleGenerate = () => {
    const newUuids = Array.from({ length: count }, () => {
      const uuid = generateUUID();
      return uppercase ? uuid.toUpperCase() : uuid;
    });
    setUuids(newUuids);
  };

  const handleCopy = async (uuid, index) => {
    try {
      await navigator.clipboard.writeText(uuid);
      setCopied(index);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(uuids.join('\n'));
      setCopied('all');
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
          <Hash size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            UUID Generator
          </h3>
        </div>

        {/* Settings */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <span className="text-sm text-os-text-primary">Count:</span>
            <input
              type="number"
              min="1"
              max="100"
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value))))}
              className="w-20 px-2 py-1 bg-os-card border border-os-border rounded-sm text-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={uppercase}
              onChange={(e) => setUppercase(e.target.checked)}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Uppercase</span>
          </label>
        </div>

        {/* Generate Button */}
        <div>
          <button
            onClick={handleGenerate}
            className="flex items-center gap-2 px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover transition-colors"
          >
            Generate UUID{count > 1 ? 's' : ''}
          </button>
        </div>

        {/* Output */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-os-text-primary">
              Generated UUIDs
            </label>
            {uuids.length > 1 && (
              <button
                onClick={handleCopyAll}
                className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
              >
                {copied === 'all' ? (
                  <>
                    <Check size={12} />
                    Copied All!
                  </>
                ) : (
                  <>
                    Copy All
                  </>
                )}
              </button>
            )}
          </div>
          {uuids.length > 0 ? (
            <div className="space-y-2">
              {uuids.map((uuid, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 px-3 py-2 bg-os-card border border-os-border rounded-sm"
                >
                  <code className="flex-1 text-sm font-mono text-os-text-primary">
                    {uuid}
                  </code>
                  <button
                    onClick={() => handleCopy(uuid, index)}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === index ? (
                      <Check size={12} className="text-green-500" />
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 bg-os-card border border-os-border rounded-sm text-center text-sm text-os-text-secondary">
              Click "Generate UUID" to create unique identifiers
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
