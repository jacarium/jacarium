import { useState } from 'react';
import { Type } from 'lucide-react';

/**
 * StringUtilitiesTool - String manipulation utilities
 *
 * Convert between different string cases and formats
 */
export default function StringUtilitiesTool() {
  const [input, setInput] = useState('');
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');

  const toCamelCase = (str) => {
    return str.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => {
      return index === 0 ? word.toLowerCase() : word.toUpperCase();
    }).replace(/\s+/g, '');
  };

  const toSnakeCase = (str) => {
    return str.replace(/\W+/g, ' ')
      .split(/ |\B(?=[A-Z])/)
      .map(word => word.toLowerCase())
      .join('_');
  };

  const toKebabCase = (str) => {
    return str.replace(/\W+/g, ' ')
      .split(/ |\B(?=[A-Z])/)
      .map(word => word.toLowerCase())
      .join('-');
  };

  const toUpperCase = (str) => str.toUpperCase();

  const toLowerCase = (str) => str.toLowerCase();

  const toCapitalize = (str) => {
    return str.replace(/\b\w/g, char => char.toUpperCase());
  };

  const handleReplace = (str) => {
    if (!searchText) return str;
    return str.split(searchText).join(replaceText);
  };

  const results = input ? {
    replace: handleReplace(input),
    camel: toCamelCase(input),
    snake: toSnakeCase(input),
    kebab: toKebabCase(input),
    upper: toUpperCase(input),
    lower: toLowerCase(input),
    capitalize: toCapitalize(input)
  } : null;

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Type size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            String Utilities
          </h3>
        </div>

        {/* Input */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Input Text
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter text to transform..."
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm resize-none"
          />
        </div>

        {/* Replace Fields */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Search Text
            </label>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Text to find..."
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Replace With
            </label>
            <input
              type="text"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              placeholder="Replacement text..."
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm"
            />
          </div>
        </div>

        {/* Results */}
        <div className="space-y-3">
          <label className="block text-sm text-os-text-primary">
            Results
          </label>

          {searchText && (
            <div>
              <div className="text-xs text-os-text-muted mb-1">Replace</div>
              <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm break-all">
                {results ? results.replace : '-'}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs text-os-text-muted mb-1">camelCase</div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm break-all font-mono">
              {results ? results.camel : '-'}
            </div>
          </div>

          <div>
            <div className="text-xs text-os-text-muted mb-1">snake_case</div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm break-all font-mono">
              {results ? results.snake : '-'}
            </div>
          </div>

          <div>
            <div className="text-xs text-os-text-muted mb-1">kebab-case</div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm break-all font-mono">
              {results ? results.kebab : '-'}
            </div>
          </div>

          <div>
            <div className="text-xs text-os-text-muted mb-1">UPPERCASE</div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm break-all">
              {results ? results.upper : '-'}
            </div>
          </div>

          <div>
            <div className="text-xs text-os-text-muted mb-1">lowercase</div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm break-all">
              {results ? results.lower : '-'}
            </div>
          </div>

          <div>
            <div className="text-xs text-os-text-muted mb-1">Capitalize Each Word</div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm break-all">
              {results ? results.capitalize : '-'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
