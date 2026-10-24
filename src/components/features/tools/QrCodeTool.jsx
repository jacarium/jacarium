import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { Hash } from 'lucide-react';

export default function QrCodeTool() {
  const [input, setInput] = useState('');
  const [errorLevel, setErrorLevel] = useState('M');
  const canvasRef = useRef(null);

  useEffect(() => {
    if (input && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, input, {
        errorCorrectionLevel: errorLevel,
        width: 300,
        margin: 2
      }).catch(err => {
        console.error('QR Code generation error:', err);
      });
    }
  }, [input, errorLevel]);

  const handleDownload = () => {
    if (canvasRef.current) {
      const url = canvasRef.current.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = 'qrcode.png';
      link.href = url;
      link.click();
    }
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Hash size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            QR Code Generator
          </h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Text/URL</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://example.com"
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Error Correction Level</label>
          <select
            value={errorLevel}
            onChange={(e) => setErrorLevel(e.target.value)}
            className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          >
            <option value="L">Low (7%)</option>
            <option value="M">Medium (15%)</option>
            <option value="Q">Quartile (25%)</option>
            <option value="H">High (30%)</option>
          </select>
        </div>
        <div className="flex flex-col items-center gap-4 p-6 bg-os-card border border-os-border rounded-sm min-h-[400px] justify-center">
          {input ? (
            <>
              <canvas ref={canvasRef}></canvas>
              <button
                onClick={handleDownload}
                className="btn btn-primary px-4 py-2 text-sm"
              >
                Download PNG
              </button>
            </>
          ) : (
            <div className="text-sm text-os-text-secondary text-center">
              <div className="mb-2">QR code will appear here</div>
              <div className="text-xs">Enter text or URL above to generate</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
