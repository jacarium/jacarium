import { useState, useRef, useEffect } from 'react';
import { Network, Check } from 'lucide-react';

export default function Ipv4SubnetCalculatorTool() {
  const [ipAddress, setIpAddress] = useState('');
  const [cidr, setCidr] = useState('24');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
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

  const calculateSubnet = () => {
    setError('');
    setResult(null);

    // Validate IP address
    const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = ipAddress.match(ipRegex);

    if (!match) {
      setError('Invalid IP address format');
      return;
    }

    const octets = match.slice(1, 5).map(Number);
    if (octets.some(octet => octet > 255)) {
      setError('IP address octets must be between 0 and 255');
      return;
    }

    const cidrNum = parseInt(cidr);
    if (cidrNum < 0 || cidrNum > 32) {
      setError('CIDR must be between 0 and 32');
      return;
    }

    // Calculate subnet details
    const ipBinary = octets.map(o => o.toString(2).padStart(8, '0')).join('');
    const subnetMaskBinary = '1'.repeat(cidrNum) + '0'.repeat(32 - cidrNum);
    const subnetMask = subnetMaskBinary.match(/.{8}/g).map(b => parseInt(b, 2)).join('.');

    // Wildcard mask (inverse of subnet mask)
    const wildcardMask = subnetMaskBinary.match(/.{8}/g).map(b => parseInt(b, 2) ^ 255).join('.');

    // Network address
    const networkBinary = ipBinary.split('').map((bit, i) =>
      subnetMaskBinary[i] === '1' ? bit : '0'
    ).join('');
    const networkAddress = networkBinary.match(/.{8}/g).map(b => parseInt(b, 2)).join('.');

    // Broadcast address
    const broadcastBinary = ipBinary.split('').map((bit, i) =>
      subnetMaskBinary[i] === '1' ? bit : '1'
    ).join('');
    const broadcastAddress = broadcastBinary.match(/.{8}/g).map(b => parseInt(b, 2)).join('.');

    // First and last host
    const networkInt = parseInt(networkBinary, 2);
    const broadcastInt = parseInt(broadcastBinary, 2);

    const firstHostInt = networkInt + 1;
    const lastHostInt = broadcastInt - 1;

    const firstHost = firstHostInt.toString(2).padStart(32, '0').match(/.{8}/g).map(b => parseInt(b, 2)).join('.');
    const lastHost = lastHostInt.toString(2).padStart(32, '0').match(/.{8}/g).map(b => parseInt(b, 2)).join('.');

    // Total hosts
    const totalHosts = Math.pow(2, 32 - cidrNum);
    const usableHosts = Math.max(0, totalHosts - 2);

    // IP class
    const firstOctet = octets[0];
    let ipClass = '';
    if (firstOctet >= 1 && firstOctet <= 126) ipClass = 'A';
    else if (firstOctet >= 128 && firstOctet <= 191) ipClass = 'B';
    else if (firstOctet >= 192 && firstOctet <= 223) ipClass = 'C';
    else if (firstOctet >= 224 && firstOctet <= 239) ipClass = 'D (Multicast)';
    else if (firstOctet >= 240 && firstOctet <= 255) ipClass = 'E (Reserved)';

    // Private IP check
    const isPrivate =
      (octets[0] === 10) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);

    setResult({
      ipAddress,
      cidr: cidrNum,
      ipClass,
      isPrivate,
      networkAddress,
      broadcastAddress,
      subnetMask,
      wildcardMask,
      firstHost,
      lastHost,
      totalHosts,
      usableHosts,
      ipBinary,
      networkBinary,
      broadcastBinary
    });
  };

  const handleCopy = async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const samples = [
    { name: 'Home Network (/24)', ip: '192.168.1.1', cidr: '24' },
    { name: 'Small Office (/28)', ip: '192.168.10.1', cidr: '28' },
    { name: 'Class C Network (/24)', ip: '10.0.0.1', cidr: '24' },
    { name: 'Class B Network (/16)', ip: '172.16.0.1', cidr: '16' },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-auto">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Network size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            IPv4 Subnet Calculator
          </h3>
        </div>

        {/* Input */}
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-2 h-[26px]">
              <label className="text-sm text-os-text-primary">
                IP Address
              </label>
            </div>
            <input
              type="text"
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && calculateSubnet()}
              placeholder="192.168.1.1"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2 h-[26px]">
              <label className="text-sm text-os-text-primary">
                CIDR / Prefix
              </label>
              <div className="relative" ref={samplesRef}>
                <button
                  onClick={() => setShowSamples(!showSamples)}
                  className="flex items-center gap-1 px-3 py-1 text-xs text-os-text-secondary hover:text-os-text-primary bg-os-card border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors"
                >
                  Samples
                </button>
                {showSamples && (
                  <div className="absolute right-0 top-full mt-1 w-64 bg-os-card border border-os-border rounded-sm shadow-lg z-10">
                    <div className="p-1">
                      {samples.map((sample, index) => (
                        <button
                          key={index}
                          onClick={() => {
                            setIpAddress(sample.ip);
                            setCidr(sample.cidr);
                            setShowSamples(false);
                          }}
                          className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                        >
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                            <code className="text-xs text-os-text-muted font-mono">{sample.ip}/{sample.cidr}</code>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <input
              type="number"
              min="0"
              max="32"
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && calculateSubnet()}
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
        </div>

        <button
          onClick={calculateSubnet}
          disabled={!ipAddress}
          className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover disabled:opacity-50 transition-colors"
        >
          Calculate
        </button>

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-os-text-primary">IP Address</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-os-text-primary">{result.ipAddress}/{result.cidr}</span>
                  <button
                    onClick={() => handleCopy(`${result.ipAddress}/${result.cidr}`, 'ip')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'ip' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-os-text-primary">IP Class</span>
                <span className="text-sm text-os-text-primary">{result.ipClass}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-os-text-primary">Type</span>
                <span className="text-sm text-os-text-primary">{result.isPrivate ? 'Private' : 'Public'}</span>
              </div>
            </div>

            {/* Network Info */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-2">
              <h4 className="text-sm font-semibold text-os-text-primary mb-3">Network Information</h4>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Network Address</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-os-text-primary">{result.networkAddress}</span>
                  <button
                    onClick={() => handleCopy(result.networkAddress, 'network')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'network' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Broadcast Address</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-os-text-primary">{result.broadcastAddress}</span>
                  <button
                    onClick={() => handleCopy(result.broadcastAddress, 'broadcast')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'broadcast' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Subnet Mask</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-os-text-primary">{result.subnetMask}</span>
                  <button
                    onClick={() => handleCopy(result.subnetMask, 'mask')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'mask' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Wildcard Mask</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-os-text-primary">{result.wildcardMask}</span>
                  <button
                    onClick={() => handleCopy(result.wildcardMask, 'wildcard')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'wildcard' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>
            </div>

            {/* Host Range */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-2">
              <h4 className="text-sm font-semibold text-os-text-primary mb-3">Host Range</h4>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">First Host</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-os-text-primary">{result.firstHost}</span>
                  <button
                    onClick={() => handleCopy(result.firstHost, 'first')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'first' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Last Host</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-os-text-primary">{result.lastHost}</span>
                  <button
                    onClick={() => handleCopy(result.lastHost, 'last')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'last' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Total Hosts</span>
                <span className="text-sm text-os-text-primary">{result.totalHosts.toLocaleString()}</span>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Usable Hosts</span>
                <span className="text-sm text-os-text-primary">{result.usableHosts.toLocaleString()}</span>
              </div>
            </div>

            {/* Binary Representation */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-2">
              <h4 className="text-sm font-semibold text-os-text-primary mb-3">Binary Representation</h4>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">IP Address</div>
                <div className="font-mono text-xs text-os-text-primary break-all">{result.ipBinary}</div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Network Address</div>
                <div className="font-mono text-xs text-os-text-primary break-all">{result.networkBinary}</div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Broadcast Address</div>
                <div className="font-mono text-xs text-os-text-primary break-all">{result.broadcastBinary}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
