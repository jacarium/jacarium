import { useState, useEffect, useRef } from 'react';
import { Check, X, Code } from 'lucide-react';

/**
 * RegexValidatorTool - Regular expression tester
 *
 * Test regex patterns against text
 */
export default function RegexValidatorTool() {
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('g');
  const [testString, setTestString] = useState('');
  const [matches, setMatches] = useState([]);
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

  const testRegex = () => {
    if (!pattern) {
      setMatches([]);
      setError('');
      return;
    }

    try {
      const regex = new RegExp(pattern, flags);
      const foundMatches = [];
      let match;

      if (flags.includes('g')) {
        while ((match = regex.exec(testString)) !== null) {
          foundMatches.push({
            match: match[0],
            index: match.index,
            groups: match.slice(1)
          });
          // Prevent infinite loops with zero-width matches
          if (match.index === regex.lastIndex) {
            regex.lastIndex++;
          }
        }
      } else {
        match = regex.exec(testString);
        if (match) {
          foundMatches.push({
            match: match[0],
            index: match.index,
            groups: match.slice(1)
          });
        }
      }

      setMatches(foundMatches);
      setError('');
    } catch (err) {
      setError('Invalid regex: ' + err.message);
      setMatches([]);
    }
  };

  const handlePatternChange = (value) => {
    setPattern(value);
  };

  const handleFlagsChange = (value) => {
    setFlags(value);
  };

  const handleTestStringChange = (value) => {
    setTestString(value);
  };

  // Auto-test when inputs change
  useEffect(() => {
    const timer = setTimeout(() => {
      testRegex();
    }, 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, flags, testString]);

  const flagOptions = [
    { value: 'g', label: 'Global' },
    { value: 'i', label: 'Case Insensitive' },
    { value: 'm', label: 'Multiline' },
    { value: 's', label: 'Dot All' }
  ];

  const samples = [
    {
      name: 'Email Address',
      pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
      test: 'Contact us at support@example.com or admin@test.org',
      flags: 'g'
    },
    {
      name: 'URL',
      pattern: 'https?:\\/\\/(www\\.)?[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b([-a-zA-Z0-9()@:%_\\+.~#?&//=]*)',
      test: 'Visit https://www.example.com and http://test.org for more info',
      flags: 'g'
    },
    {
      name: 'Phone Number (US)',
      pattern: '\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}',
      test: 'Call (555) 123-4567 or 555.987.6543 or 5551234567',
      flags: 'g'
    },
    {
      name: 'IP Address (IPv4)',
      pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
      test: 'Server IPs: 192.168.1.1 and 10.0.0.1',
      flags: 'g'
    },
    {
      name: 'Date (YYYY-MM-DD)',
      pattern: '\\d{4}-\\d{2}-\\d{2}',
      test: 'Events on 2024-12-25 and 2025-01-01',
      flags: 'g'
    },
    {
      name: 'Hexadecimal Color',
      pattern: '#[0-9A-Fa-f]{6}\\b|#[0-9A-Fa-f]{3}\\b',
      test: 'Colors: #FF5733, #000, #abc123',
      flags: 'g'
    },
    {
      name: 'HTML Tag',
      pattern: '<\\/?[a-z][a-z0-9]*[^<>]*>',
      test: '<div class="container"><p>Hello</p></div>',
      flags: 'gi'
    },
    {
      name: 'Username (alphanumeric, 3-16 chars)',
      pattern: '^[a-zA-Z0-9_]{3,16}$',
      test: 'user123',
      flags: ''
    },
    {
      name: 'Credit Card Number',
      pattern: '\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}',
      test: '1234 5678 9012 3456 or 1234-5678-9012-3456',
      flags: 'g'
    },
    {
      name: 'Time (24-hour)',
      pattern: '([01]?[0-9]|2[0-3]):[0-5][0-9]',
      test: 'Meeting at 09:30 and 14:45',
      flags: 'g'
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Regex Validator
          </h3>
        </div>

        {/* Pattern Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">
              Regular Expression Pattern
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
                          setPattern(sample.pattern);
                          setFlags(sample.flags);
                          setTestString(sample.test);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.pattern}</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-os-text-muted">/</span>
            <input
              type="text"
              value={pattern}
              onChange={(e) => handlePatternChange(e.target.value)}
              placeholder="Enter regex pattern..."
              className="flex-1 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
            />
            <span className="text-os-text-muted">/</span>
            <input
              type="text"
              value={flags}
              onChange={(e) => handleFlagsChange(e.target.value)}
              placeholder="flags"
              className="w-20 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
            />
          </div>
          <div className="mt-2 flex gap-2">
            {flagOptions.map(({ value, label }) => (
              <label key={value} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={flags.includes(value)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      handleFlagsChange(flags + value);
                    } else {
                      handleFlagsChange(flags.replace(value, ''));
                    }
                    setTimeout(testRegex, 0);
                  }}
                  className="text-os-blue focus:ring-os-blue"
                />
                <span className="text-xs text-os-text-secondary">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Test String */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Test String
          </label>
          <textarea
            value={testString}
            onChange={(e) => handleTestStringChange(e.target.value)}
            placeholder="Enter text to test against..."
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue text-sm resize-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            <X size={16} />
            {error}
          </div>
        )}

        {/* Results */}
        <div>
          <label className="block text-sm text-os-text-primary mb-3">Matches</label>
          {!error && pattern ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                {matches.length > 0 ? (
                  <>
                    <Check size={16} className="text-green-500" />
                    <span className="text-sm font-medium text-os-text-primary">
                      {matches.length} match{matches.length !== 1 ? 'es' : ''} found
                    </span>
                  </>
                ) : (
                  <>
                    <X size={16} className="text-os-text-muted" />
                    <span className="text-sm font-medium text-os-text-muted">
                      No matches found
                    </span>
                  </>
                )}
              </div>

              {matches.length > 0 && (
                <div className="space-y-2">
                  {matches.map((match, index) => (
                    <div key={index} className="px-3 py-2 bg-os-card border border-os-border rounded-sm">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-os-text-muted">
                          Match {index + 1}
                        </span>
                        <span className="text-xs text-os-text-muted">
                          Index: {match.index}
                        </span>
                      </div>
                      <div className="font-mono text-sm text-os-text-primary break-all">
                        {match.match}
                      </div>
                      {match.groups.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-os-border">
                          <div className="text-xs text-os-text-muted mb-1">Capture Groups:</div>
                          {match.groups.map((group, groupIndex) => (
                            <div key={groupIndex} className="text-xs font-mono text-os-text-secondary">
                              Group {groupIndex + 1}: {group || '(empty)'}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="p-8 bg-os-card border border-os-border rounded-sm text-center text-sm text-os-text-secondary">
              <div className="mb-2">Matches will appear here</div>
              <div className="text-xs">Enter a regex pattern and test string above</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
