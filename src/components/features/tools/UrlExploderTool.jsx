import { useState, useEffect, useRef } from 'react';
import { Link } from 'lucide-react';

export default function UrlExploderTool() {
  const [url, setUrl] = useState('');
  const [components, setComponents] = useState({
    protocol: '',
    username: '',
    password: '',
    host: '',
    port: '',
    path: '',
    query: '',
    hash: ''
  });
  const [error, setError] = useState('');
  const [isUpdatingFromUrl, setIsUpdatingFromUrl] = useState(false);
  const [isUpdatingFromComponents, setIsUpdatingFromComponents] = useState(false);
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

  // Parse URL and update components
  const parseUrl = (urlString) => {
    if (!urlString || !urlString.trim()) {
      setComponents({
        protocol: '',
        username: '',
        password: '',
        host: '',
        port: '',
        path: '',
        query: '',
        hash: ''
      });
      setError('');
      return;
    }

    try {
      const urlObj = new URL(urlString);

      // Convert search params to multi-line format
      let queryString = '';
      urlObj.searchParams.forEach((value, key) => {
        queryString += `${key}=${value}\n`;
      });
      queryString = queryString.trim();

      setIsUpdatingFromUrl(true);
      setComponents({
        protocol: urlObj.protocol.replace(':', ''),
        username: urlObj.username,
        password: urlObj.password,
        host: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        query: queryString,
        hash: urlObj.hash.replace('#', '')
      });
      setError('');
    } catch {
      setError('Invalid URL');
    } finally {
      setTimeout(() => setIsUpdatingFromUrl(false), 0);
    }
  };

  // Build URL from components
  const buildUrl = (comps) => {
    try {
      if (!comps.protocol || !comps.host) {
        setUrl('');
        setError('');
        return;
      }

      let urlString = `${comps.protocol}://`;

      // Add credentials if present
      if (comps.username) {
        urlString += comps.username;
        if (comps.password) {
          urlString += `:${comps.password}`;
        }
        urlString += '@';
      }

      // Add host
      urlString += comps.host;

      // Add port if present
      if (comps.port) {
        urlString += `:${comps.port}`;
      }

      // Add path
      if (comps.path) {
        urlString += comps.path.startsWith('/') ? comps.path : `/${comps.path}`;
      }

      // Parse and add query parameters
      if (comps.query && comps.query.trim()) {
        const params = new URLSearchParams();
        const lines = comps.query.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          const [key, ...valueParts] = line.split('=');
          if (key && key.trim()) {
            params.append(key.trim(), valueParts.join('=').trim());
          }
        });
        const queryStr = params.toString();
        if (queryStr) {
          urlString += `?${queryStr}`;
        }
      }

      // Add hash
      if (comps.hash) {
        urlString += `#${comps.hash}`;
      }

      setIsUpdatingFromComponents(true);
      setUrl(urlString);
      setError('');
    } catch (err) {
      setError('Failed to build URL: ' + err.message);
    } finally {
      setTimeout(() => setIsUpdatingFromComponents(false), 0);
    }
  };

  // When URL changes, parse it. Deliberate two-way binding between the raw
  // URL and its exploded components; the isUpdatingFrom* flags stop the two
  // effects from re-triggering each other.
  useEffect(() => {
    if (!isUpdatingFromComponents) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      parseUrl(url);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // When components change, rebuild URL (other half of the two-way binding)
  useEffect(() => {
    if (!isUpdatingFromUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      buildUrl(components);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components]);

  const handleComponentChange = (field, value) => {
    setComponents(prev => ({ ...prev, [field]: value }));
  };

  const samples = [
    {
      name: 'API Endpoint',
      url: 'https://api.example.com:443/v1/users?page=1&limit=10#results'
    },
    {
      name: 'Authenticated URL',
      url: 'https://user:password@secure.example.com:8443/admin/dashboard'
    },
    {
      name: 'Query Parameters',
      url: 'https://search.example.com/search?q=javascript&sort=date&filter=tutorial'
    },
    {
      name: 'Hash Fragment',
      url: 'https://docs.example.com/guide/introduction#getting-started'
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-auto">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Link size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            URL Exploder
          </h3>
        </div>

        {/* Full URL */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">URL</label>
            <div className="relative" ref={samplesRef}>
              <button
                onClick={() => setShowSamples(!showSamples)}
                className="flex items-center gap-1 px-3 py-1 text-xs text-os-text-secondary hover:text-os-text-primary bg-os-card border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors"
              >
                Samples
              </button>
              {showSamples && (
                <div className="absolute right-0 top-full mt-1 w-96 bg-os-card border border-os-border rounded-sm shadow-lg z-10 max-h-96 overflow-auto">
                  <div className="p-1">
                    {samples.map((sample, index) => (
                      <button
                        key={index}
                        onClick={() => {
                          setUrl(sample.url);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.url}</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://user:pass@example.com:8080/path?key=value#hash"
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
          />
        </div>

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* URL Components */}
        <div className="space-y-4">
          <h4 className="text-sm font-medium text-os-text-primary">URL Components</h4>

          <div className="grid grid-cols-2 gap-4">
            {/* Protocol */}
            <div>
              <label className="block text-sm text-os-text-primary mb-2">Protocol</label>
              <input
                type="text"
                value={components.protocol}
                onChange={(e) => handleComponentChange('protocol', e.target.value)}
                placeholder="https"
                className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
              />
            </div>

            {/* Host */}
            <div>
              <label className="block text-sm text-os-text-primary mb-2">Host</label>
              <input
                type="text"
                value={components.host}
                onChange={(e) => handleComponentChange('host', e.target.value)}
                placeholder="example.com"
                className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
              />
            </div>

            {/* Port */}
            <div>
              <label className="block text-sm text-os-text-primary mb-2">Port</label>
              <input
                type="text"
                value={components.port}
                onChange={(e) => handleComponentChange('port', e.target.value)}
                placeholder="8080"
                className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
              />
            </div>

            {/* Path */}
            <div>
              <label className="block text-sm text-os-text-primary mb-2">Path</label>
              <input
                type="text"
                value={components.path}
                onChange={(e) => handleComponentChange('path', e.target.value)}
                placeholder="/api/users"
                className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
              />
            </div>

            {/* Username */}
            <div>
              <label className="block text-sm text-os-text-primary mb-2">Username</label>
              <input
                type="text"
                value={components.username}
                onChange={(e) => handleComponentChange('username', e.target.value)}
                placeholder="user"
                className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm text-os-text-primary mb-2">Password</label>
              <input
                type="text"
                value={components.password}
                onChange={(e) => handleComponentChange('password', e.target.value)}
                placeholder="password"
                className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
              />
            </div>

            {/* Hash */}
            <div className="col-span-2">
              <label className="block text-sm text-os-text-primary mb-2">Hash</label>
              <input
                type="text"
                value={components.hash}
                onChange={(e) => handleComponentChange('hash', e.target.value)}
                placeholder="section"
                className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
              />
            </div>
          </div>

          {/* Query (Multi-line) */}
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Query Parameters (one per line: key=value)</label>
            <textarea
              value={components.query}
              onChange={(e) => handleComponentChange('query', e.target.value)}
              placeholder="key1=value1&#10;key2=value2&#10;key3=value3"
              className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono resize-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
