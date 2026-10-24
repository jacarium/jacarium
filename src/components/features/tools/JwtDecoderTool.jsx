import { useState, useRef, useEffect } from 'react';
import { jwtDecode } from 'jwt-decode';
import { Code } from 'lucide-react';

export default function JwtDecoderTool() {
  const [token, setToken] = useState('');
  const [header, setHeader] = useState(null);
  const [payload, setPayload] = useState(null);
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

  const handleDecode = () => {
    try {
      const decoded = jwtDecode(token, { header: true });
      const parts = token.split('.');
      const headerDecoded = JSON.parse(atob(parts[0]));
      setHeader(headerDecoded);
      setPayload(decoded);
      setError('');
    } catch {
      setError('Invalid JWT token');
      setHeader(null);
      setPayload(null);
    }
  };

  const samples = [
    {
      name: 'User Authentication',
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    },
    {
      name: 'Admin Token',
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5ODc2NTQzMjEiLCJuYW1lIjoiQWRtaW4gVXNlciIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTYwOTQ1OTIwMCwiZXhwIjoxNjA5NDYyODAwfQ.oXGNLvVCxDQk7bFJzAHXQMhKOYzYkHMjZPvbGMvILfg'
    },
    {
      name: 'API Access Token',
      token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2V4YW1wbGUuY29tIiwic3ViIjoiYXBpLWNsaWVudC0xMjMiLCJhdWQiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbSIsImV4cCI6MTcwMDAwMDAwMCwiaWF0IjoxNjk5OTk2NDAwLCJzY29wZSI6InJlYWQ6dXNlcnMgd3JpdGU6dXNlcnMifQ.signature'
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            JSON Web Token Decoder
          </h3>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">JWT Token</label>
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
                          setToken(sample.token);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.token.substring(0, 50)}...</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue placeholder:text-os-text-muted" />
        </div>
        <button onClick={handleDecode} disabled={!token} className="btn btn-primary px-4 py-2 text-sm">Decode</button>
        {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Header</label>
          <pre className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-xs overflow-auto min-h-[100px]">{header ? JSON.stringify(header, null, 2) : "JWT header will appear here..."}</pre>
        </div>
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Payload</label>
          <pre className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-xs overflow-auto min-h-[100px]">{payload ? JSON.stringify(payload, null, 2) : "JWT payload will appear here..."}</pre>
        </div>
      </div>
    </div>
  );
}
