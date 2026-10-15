import { useState } from 'react';
import { Globe, Copy, Check, Monitor } from 'lucide-react';
import { can, desktopOnly } from '../../../utils/platform';
import { getBackendUrl, apiFetch } from '../../../utils/backendUrl';

export default function WhoisLookupTool() {
  const [domain, setDomain] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  // The lookup runs the system whois binary from the Electron main process
  const whoisAvailable = can('whois');

  const handleLookup = async () => {
    if (!domain) return;

    setLoading(true);
    setError('');
    setResult('');

    try {
      // The desktop app queries whois from the main process; in a browser
      // the backend does the same (POST /api/whois) when it offers it.
      if (window.electronAPI && window.electronAPI.whoisLookup) {
        const output = await window.electronAPI.whoisLookup(domain.trim());
        setResult(output);
      } else if (whoisAvailable) {
        const backendUrl = await getBackendUrl();
        const response = await apiFetch(`${backendUrl}/api/whois`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: domain.trim() }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `WHOIS lookup failed (HTTP ${response.status})`);
        }
        setResult(data.result || '');
      } else {
        setError(desktopOnly('WHOIS lookup'));
      }
    } catch (err) {
      setError(`Error: ${err.message || 'WHOIS lookup failed'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(result);
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
          <Globe size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            WHOIS Lookup
          </h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Domain Name</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleLookup()}
              placeholder="example.com"
              disabled={loading}
              className="flex-1 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue disabled:opacity-50"
            />
            <button
              onClick={handleLookup}
              disabled={!whoisAvailable || !domain || loading}
              title={whoisAvailable ? undefined : desktopOnly('WHOIS lookup')}
              className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover disabled:opacity-50 transition-colors"
            >
              {loading ? 'Looking up...' : 'Lookup'}
            </button>
          </div>
        </div>
        {!whoisAvailable && (
          <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-sm text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <Monitor size={16} className="shrink-0 mt-0.5" />
            <span>{desktopOnly('WHOIS lookup')}.</span>
          </div>
        )}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">WHOIS Information</label>
            {result && (
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
          <pre className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-xs overflow-auto max-h-96 whitespace-pre-wrap min-h-[200px]">
            {result || "WHOIS information will appear here after clicking 'Lookup'..."}
          </pre>
        </div>
      </div>
    </div>
  );
}
