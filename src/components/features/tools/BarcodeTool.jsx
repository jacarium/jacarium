import { useState, useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import { Hash } from 'lucide-react';

export default function BarcodeTool() {
  const [input, setInput] = useState('');
  const [format, setFormat] = useState('CODE128');
  const [error, setError] = useState('');
  const canvasRef = useRef(null);

  useEffect(() => {
    if (input && canvasRef.current) {
      try {
        JsBarcode(canvasRef.current, input, {
          format: format,
          width: 2,
          height: 100,
          displayValue: true
        });
        // Intentional external-system sync in an effect; the setState here is
        // the subscription/measurement result, not derived render state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setError('');
      } catch (err) {
        setError(err.message);
      }
    }
  }, [input, format]);

  const handleDownload = () => {
    if (canvasRef.current) {
      const url = canvasRef.current.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = 'barcode.png';
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
            Barcode Generator
          </h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Barcode Value</label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="123456789012"
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Barcode Format</label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          >
            <option value="CODE128">CODE128</option>
            <option value="CODE39">CODE39</option>
            <option value="EAN13">EAN13</option>
            <option value="EAN8">EAN8</option>
            <option value="UPC">UPC</option>
            <option value="ITF14">ITF14</option>
            <option value="MSI">MSI</option>
            <option value="pharmacode">Pharmacode</option>
          </select>
        </div>
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        <div className="flex flex-col items-center gap-4 p-6 bg-os-card border border-os-border rounded-sm min-h-[200px] justify-center">
          {input && !error ? (
            <>
              <canvas ref={canvasRef}></canvas>
              <button
                onClick={handleDownload}
                className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover transition-colors"
              >
                Download PNG
              </button>
            </>
          ) : (
            <div className="text-sm text-os-text-secondary text-center">
              <div className="mb-2">Barcode will appear here</div>
              <div className="text-xs">Enter a value above to generate</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
