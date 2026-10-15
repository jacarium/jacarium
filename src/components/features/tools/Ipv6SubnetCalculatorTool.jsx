import { useState, useRef, useEffect } from 'react';
import { Network, Check } from 'lucide-react';

export default function Ipv6SubnetCalculatorTool() {
  const [ipAddress, setIpAddress] = useState('');
  const [prefix, setPrefix] = useState('64');
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

  // Expand compressed IPv6 address
  const expandIPv6 = (ip) => {
    let fullAddress = ip;

    // Handle :: expansion
    if (fullAddress.includes('::')) {
      const sides = fullAddress.split('::');
      const leftGroups = sides[0] ? sides[0].split(':') : [];
      const rightGroups = sides[1] ? sides[1].split(':') : [];
      const missingGroups = 8 - leftGroups.length - rightGroups.length;
      const middleGroups = Array(missingGroups).fill('0000');
      fullAddress = [...leftGroups, ...middleGroups, ...rightGroups].join(':');
    }

    // Pad each group to 4 digits
    const groups = fullAddress.split(':');
    return groups.map(g => g.padStart(4, '0')).join(':');
  };

  // Compress IPv6 address
  const compressIPv6 = (ip) => {
    // Remove leading zeros
    let compressed = ip.split(':').map(g => g.replace(/^0+/, '') || '0').join(':');

    // Find longest sequence of zeros
    const zeroSequences = [];
    let currentSequence = null;

    compressed.split(':').forEach((group, index) => {
      if (group === '0') {
        if (currentSequence === null) {
          currentSequence = { start: index, length: 1 };
        } else {
          currentSequence.length++;
        }
      } else {
        if (currentSequence !== null) {
          zeroSequences.push(currentSequence);
          currentSequence = null;
        }
      }
    });

    if (currentSequence !== null) {
      zeroSequences.push(currentSequence);
    }

    // Replace longest sequence with ::
    if (zeroSequences.length > 0) {
      const longest = zeroSequences.sort((a, b) => b.length - a.length)[0];
      if (longest.length > 1) {
        const groups = compressed.split(':');
        groups.splice(longest.start, longest.length, '');
        compressed = groups.join(':').replace(/:{2,}/, '::');
        if (compressed.startsWith(':') && !compressed.startsWith('::')) {
          compressed = ':' + compressed;
        }
        if (compressed.endsWith(':') && !compressed.endsWith('::')) {
          compressed = compressed + ':';
        }
      }
    }

    return compressed;
  };

  const calculateSubnet = () => {
    setError('');
    setResult(null);

    if (!ipAddress) {
      setError('Please enter an IPv6 address');
      return;
    }

    const prefixNum = parseInt(prefix);
    if (prefixNum < 0 || prefixNum > 128) {
      setError('Prefix must be between 0 and 128');
      return;
    }

    try {
      // Expand the IPv6 address
      const expanded = expandIPv6(ipAddress.trim());

      // Validate format
      const ipv6Regex = /^([0-9a-fA-F]{4}:){7}[0-9a-fA-F]{4}$/;
      if (!ipv6Regex.test(expanded)) {
        setError('Invalid IPv6 address format');
        return;
      }

      // Convert to binary
      const groups = expanded.split(':');
      const binary = groups.map(g => parseInt(g, 16).toString(2).padStart(16, '0')).join('');

      // Create subnet mask
      const maskBinary = '1'.repeat(prefixNum) + '0'.repeat(128 - prefixNum);

      // Calculate network address
      const networkBinary = binary.split('').map((bit, i) =>
        maskBinary[i] === '1' ? bit : '0'
      ).join('');

      // Calculate first address (network + 1)
      const networkInt = BigInt('0b' + networkBinary);
      const firstInt = networkInt + 1n;

      // Calculate last address (all host bits set to 1)
      const lastBinary = binary.split('').map((bit, i) =>
        maskBinary[i] === '1' ? bit : '1'
      ).join('');

      // Convert binary back to IPv6
      const binaryToIPv6 = (bin) => {
        const groups = [];
        for (let i = 0; i < 128; i += 16) {
          groups.push(parseInt(bin.substr(i, 16), 2).toString(16).padStart(4, '0'));
        }
        return groups.join(':');
      };

      const networkAddress = binaryToIPv6(networkBinary);
      const firstAddress = binaryToIPv6(firstInt.toString(2).padStart(128, '0'));
      const lastAddress = binaryToIPv6(lastBinary);

      // Total addresses in subnet
      const totalAddresses = 2n ** BigInt(128 - prefixNum);

      // IPv6 address type
      let addressType = 'Global Unicast';
      if (expanded.startsWith('fe80:')) addressType = 'Link-Local';
      else if (expanded.startsWith('ff')) addressType = 'Multicast';
      else if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') addressType = 'Loopback';
      else if (expanded.startsWith('fc') || expanded.startsWith('fd')) addressType = 'Unique Local';

      setResult({
        input: ipAddress,
        expanded,
        compressed: compressIPv6(expanded),
        prefix: prefixNum,
        addressType,
        networkAddress,
        networkCompressed: compressIPv6(networkAddress),
        firstAddress,
        firstCompressed: compressIPv6(firstAddress),
        lastAddress,
        lastCompressed: compressIPv6(lastAddress),
        totalAddresses: totalAddresses.toString(),
        binary,
        networkBinary,
        maskBinary
      });
    } catch (err) {
      setError('Error calculating subnet: ' + err.message);
    }
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
    { name: 'Documentation Prefix', ip: '2001:db8::1', prefix: '64' },
    { name: 'Google DNS', ip: '2001:4860:4860::8888', prefix: '128' },
    { name: 'Link-Local', ip: 'fe80::1', prefix: '64' },
    { name: 'Unique Local', ip: 'fd00::1', prefix: '48' },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-auto">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Network size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            IPv6 Subnet Calculator
          </h3>
        </div>

        {/* Input */}
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-2 h-[26px]">
              <label className="text-sm text-os-text-primary">
                IPv6 Address
              </label>
            </div>
            <input
              type="text"
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && calculateSubnet()}
              placeholder="2001:db8::1 or 2001:0db8:0000:0000:0000:0000:0000:0001"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2 h-[26px]">
              <label className="text-sm text-os-text-primary">
                Prefix Length
              </label>
              <div className="relative" ref={samplesRef}>
                <button
                  onClick={() => setShowSamples(!showSamples)}
                  className="flex items-center gap-1 px-3 py-1 text-xs text-os-text-secondary hover:text-os-text-primary bg-os-card border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors"
                >
                  Samples
                </button>
                {showSamples && (
                  <div className="absolute right-0 top-full mt-1 w-72 bg-os-card border border-os-border rounded-sm shadow-lg z-10">
                    <div className="p-1">
                      {samples.map((sample, index) => (
                        <button
                          key={index}
                          onClick={() => {
                            setIpAddress(sample.ip);
                            setPrefix(sample.prefix);
                            setShowSamples(false);
                          }}
                          className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                        >
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                            <code className="text-xs text-os-text-muted font-mono">{sample.ip}/{sample.prefix}</code>
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
              max="128"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
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
            {/* Address Info */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-2">
              <h4 className="text-sm font-semibold text-os-text-primary mb-3">Address Information</h4>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Expanded</div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-sm text-os-text-primary break-all flex-1">{result.expanded}</div>
                  <button
                    onClick={() => handleCopy(result.expanded, 'expanded')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'expanded' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Compressed</div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-sm text-os-text-primary break-all flex-1">{result.compressed}</div>
                  <button
                    onClick={() => handleCopy(result.compressed, 'compressed')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'compressed' ? <Check size={14} /> : null}
                  </button>
                </div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Address Type</span>
                <span className="text-sm text-os-text-primary">{result.addressType}</span>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Prefix Length</span>
                <span className="text-sm text-os-text-primary">/{result.prefix}</span>
              </div>
            </div>

            {/* Network Info */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-3">
              <h4 className="text-sm font-semibold text-os-text-primary mb-3">Network Information</h4>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Network Address</div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-xs text-os-text-primary break-all flex-1">{result.networkAddress}</div>
                  <button
                    onClick={() => handleCopy(result.networkAddress, 'network')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'network' ? <Check size={14} /> : null}
                  </button>
                </div>
                <div className="font-mono text-xs text-os-text-muted">{result.networkCompressed}</div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">First Address</div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-xs text-os-text-primary break-all flex-1">{result.firstAddress}</div>
                  <button
                    onClick={() => handleCopy(result.firstAddress, 'first')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'first' ? <Check size={14} /> : null}
                  </button>
                </div>
                <div className="font-mono text-xs text-os-text-muted">{result.firstCompressed}</div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Last Address</div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-xs text-os-text-primary break-all flex-1">{result.lastAddress}</div>
                  <button
                    onClick={() => handleCopy(result.lastAddress, 'last')}
                    className="p-1 text-os-text-secondary hover:text-os-text-primary transition-colors"
                  >
                    {copied === 'last' ? <Check size={14} /> : null}
                  </button>
                </div>
                <div className="font-mono text-xs text-os-text-muted">{result.lastCompressed}</div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-os-text-secondary">Total Addresses</span>
                <span className="text-sm text-os-text-primary font-mono">{result.totalAddresses}</span>
              </div>
            </div>

            {/* Binary Representation */}
            <div className="p-4 bg-os-card border border-os-border rounded-sm space-y-2">
              <h4 className="text-sm font-semibold text-os-text-primary mb-3">Binary Representation</h4>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Address (128 bits)</div>
                <div className="font-mono text-xs text-os-text-primary break-all">{result.binary}</div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Network Address (128 bits)</div>
                <div className="font-mono text-xs text-os-text-primary break-all">{result.networkBinary}</div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-os-text-secondary">Subnet Mask (128 bits)</div>
                <div className="font-mono text-xs text-os-text-primary break-all">{result.maskBinary}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
