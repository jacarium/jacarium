import { useState } from 'react';
import { Code, Copy, Check } from 'lucide-react';
import { generateCsr, parseDomains } from '../../../utils/csr';

export default function CsrGeneratorTool() {
  const [formData, setFormData] = useState({
    domainNames: '',
    keyType: 'RSA-4096',
    country: '',
    state: '',
    locality: '',
    organization: '',
    organizationalUnit: '',
    email: ''
  });
  const [csrPem, setCsrPem] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [decodedCsr, setDecodedCsr] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleGenerate = async () => {
    try {
      if (parseDomains(formData.domainNames).length === 0) {
        setError('Domain name is required');
        return;
      }

      setError('');
      setLoading(true);

      // Keys from WebCrypto, the PKCS#10 request from pkijs (src/utils/csr.js):
      // same subject order, SANs and PEM shapes the previous node-forge
      // version produced - and real EC keys for the ECDSA options
      const { csrPem: pem, privateKeyPem: privateKeyPemStr, domains, subject, keyInfo } = await generateCsr(formData);
      setCsrPem(pem);
      setPrivateKeyPem(privateKeyPemStr);

      // Generate decoded view
      let decoded = 'Subject:\n';
      subject.forEach(attr => {
        decoded += `${attr.name}: ${attr.value}\n`;
      });

      decoded += '\nPublic Key:\n';
      decoded += `Type: ${keyInfo.type}\n`;
      if (keyInfo.type === 'RSA') {
        decoded += `Size: ${keyInfo.size} bits\n`;
      } else if (keyInfo.type === 'ECDSA') {
        decoded += `Curve: ${keyInfo.curve}\n`;
      }

      if (domains.length > 0) {
        decoded += '\nSubject Alternative Names:\n';
        domains.forEach(domain => {
          decoded += `${domain}\n`;
        });
      }

      decoded += '\nSignature Algorithm:\nSHA-256 with ' + keyInfo.type;

      setDecodedCsr(decoded);
    } catch (err) {
      setError('Failed to generate CSR: ' + err.message);
      setCsrPem('');
      setPrivateKeyPem('');
      setDecodedCsr('');
    } finally {
      setLoading(false);
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

  const handleDownloadPrivateKey = () => {
    if (!privateKeyPem) return;

    const blob = new Blob([privateKeyPem], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'private-key.pem';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-auto">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            CSR Generator
          </h3>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-sm text-os-text-primary mb-2">Domain Names *</label>
            <input
              type="text"
              value={formData.domainNames}
              onChange={(e) => handleChange('domainNames', e.target.value)}
              placeholder="example.com, www.example.com (comma separated)"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Key Type *</label>
            <select
              value={formData.keyType}
              onChange={(e) => handleChange('keyType', e.target.value)}
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            >
              <option value="RSA-4096">RSA 4096</option>
              <option value="RSA-2048">RSA 2048</option>
              <option value="ECDSA-p256">ECDSA p256</option>
              <option value="ECDSA-p384">ECDSA p384</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Country Name</label>
            <input
              type="text"
              value={formData.country}
              onChange={(e) => handleChange('country', e.target.value)}
              placeholder="US"
              maxLength="2"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">State or Province Name</label>
            <input
              type="text"
              value={formData.state}
              onChange={(e) => handleChange('state', e.target.value)}
              placeholder="California"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Locality Name</label>
            <input
              type="text"
              value={formData.locality}
              onChange={(e) => handleChange('locality', e.target.value)}
              placeholder="San Francisco"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Organization Name</label>
            <input
              type="text"
              value={formData.organization}
              onChange={(e) => handleChange('organization', e.target.value)}
              placeholder="My Company"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Organizational Unit Name</label>
            <input
              type="text"
              value={formData.organizationalUnit}
              onChange={(e) => handleChange('organizationalUnit', e.target.value)}
              placeholder="IT Department"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-os-text-primary mb-2">Email Address</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => handleChange('email', e.target.value)}
              placeholder="admin@example.com"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleGenerate}
            disabled={!formData.domainNames || loading}
            className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover disabled:opacity-50 transition-colors"
          >
            {loading ? 'Generating...' : 'Generate'}
          </button>
          {privateKeyPem && (
            <button
              onClick={handleDownloadPrivateKey}
              className="px-4 py-2 bg-os-card text-os-text-primary text-sm rounded-sm border border-os-border hover:bg-os-card-secondary transition-colors"
            >
              Download Private Key
            </button>
          )}
        </div>

        {loading && (
          <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-sm text-sm text-blue-600 dark:text-blue-400">
            Generating keys... This may take a few seconds for larger key sizes.
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Certificate Request */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">Certificate Request</label>
            {csrPem && (
              <button
                onClick={() => handleCopy(csrPem, 'csr')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
              >
                {copied === 'csr' ? (
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
          {csrPem ? (
            <pre className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-xs overflow-auto whitespace-pre-wrap min-h-[200px]">
              {csrPem}
            </pre>
          ) : (
            <div className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary min-h-[200px]">
              Certificate request will appear here after clicking Generate
            </div>
          )}
        </div>

        {/* Decoded CSR */}
        {decodedCsr && (
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm text-os-text-primary">Decoded CSR</label>
              <button
                onClick={() => handleCopy(decodedCsr, 'decoded')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
              >
                {copied === 'decoded' ? (
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
            </div>
            <pre className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-xs overflow-auto whitespace-pre-wrap min-h-[200px]">
              {decodedCsr}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
