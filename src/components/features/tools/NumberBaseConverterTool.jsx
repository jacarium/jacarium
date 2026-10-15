import { useState } from 'react';
import { Hash } from 'lucide-react';

/**
 * NumberBaseConverterTool - Number base converter
 *
 * Converts numbers between Base 2 (Binary), Base 8 (Octal), Base 10 (Decimal), and Base 16 (Hexadecimal)
 */
export default function NumberBaseConverterTool() {
  const [binary, setBinary] = useState('');
  const [octal, setOctal] = useState('');
  const [decimal, setDecimal] = useState('');
  const [hexadecimal, setHexadecimal] = useState('');
  const [error, setError] = useState('');

  const updateAllBases = (value, fromBase) => {
    try {
      if (!value) {
        setBinary('');
        setOctal('');
        setDecimal('');
        setHexadecimal('');
        setError('');
        return;
      }

      // Convert to decimal first
      const decimalValue = parseInt(value, fromBase);

      if (isNaN(decimalValue)) {
        setError(`Invalid ${getBaseName(fromBase)} number`);
        return;
      }

      if (decimalValue < 0) {
        setError('Negative numbers are not supported');
        return;
      }

      // Update all fields
      setBinary(decimalValue.toString(2));
      setOctal(decimalValue.toString(8));
      setDecimal(decimalValue.toString(10));
      setHexadecimal(decimalValue.toString(16).toUpperCase());
      setError('');
    } catch (err) {
      setError('Conversion error: ' + err.message);
    }
  };

  const getBaseName = (base) => {
    switch (base) {
      case 2: return 'Binary';
      case 8: return 'Octal';
      case 10: return 'Decimal';
      case 16: return 'Hexadecimal';
      default: return 'Unknown';
    }
  };

  const validateInput = (value, base) => {
    if (!value) return true;

    switch (base) {
      case 2:
        return /^[01]+$/.test(value);
      case 8:
        return /^[0-7]+$/.test(value);
      case 10:
        return /^\d+$/.test(value);
      case 16:
        return /^[0-9A-Fa-f]+$/.test(value);
      default:
        return false;
    }
  };

  const handleBinaryChange = (value) => {
    // Allow input with leading zeros
    if (validateInput(value, 2) || value === '') {
      setBinary(value);
      // Remove leading zeros for conversion, but keep at least one digit
      const cleanValue = value.replace(/^0+/, '') || '0';
      updateAllBases(cleanValue, 2);
    }
  };

  const handleOctalChange = (value) => {
    if (validateInput(value, 8) || value === '') {
      setOctal(value);
      updateAllBases(value, 8);
    }
  };

  const handleDecimalChange = (value) => {
    if (validateInput(value, 10) || value === '') {
      setDecimal(value);
      updateAllBases(value, 10);
    }
  };

  const handleDecimalKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const currentValue = parseInt(decimal || '0', 10);
      const newValue = currentValue + 1;
      setDecimal(newValue.toString());
      updateAllBases(newValue.toString(), 10);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const currentValue = parseInt(decimal || '0', 10);
      const newValue = Math.max(0, currentValue - 1);
      setDecimal(newValue.toString());
      updateAllBases(newValue.toString(), 10);
    }
  };

  const handleHexadecimalChange = (value) => {
    const upperValue = value.toUpperCase();
    if (validateInput(upperValue, 16) || upperValue === '') {
      setHexadecimal(upperValue);
      updateAllBases(upperValue, 16);
    }
  };

  const handleClear = () => {
    setBinary('');
    setOctal('');
    setDecimal('');
    setHexadecimal('');
    setError('');
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Hash size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Number Base Converter
          </h3>
        </div>

        <p className="text-sm text-os-text-secondary">
          Enter a number in any base to see its conversion in all other bases
        </p>

        {/* Binary (Base 2) */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Binary (Base 2)
          </label>
          <input
            type="text"
            value={binary}
            onChange={(e) => handleBinaryChange(e.target.value)}
            placeholder="Enter binary..."
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
          />
          <div className="mt-1 text-xs text-os-text-muted">
            Valid characters: 0, 1
          </div>
        </div>

        {/* Octal (Base 8) */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Octal (Base 8)
          </label>
          <input
            type="text"
            value={octal}
            onChange={(e) => handleOctalChange(e.target.value)}
            placeholder="Enter octal..."
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
          />
          <div className="mt-1 text-xs text-os-text-muted">
            Valid characters: 0-7
          </div>
        </div>

        {/* Decimal (Base 10) */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Decimal (Base 10)
          </label>
          <input
            type="text"
            value={decimal}
            onChange={(e) => handleDecimalChange(e.target.value)}
            onKeyDown={handleDecimalKeyDown}
            placeholder="Enter decimal..."
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
          />
          <div className="mt-1 text-xs text-os-text-muted">
            Valid characters: 0-9 • Use ↑↓ arrows to increment/decrement
          </div>
        </div>

        {/* Hexadecimal (Base 16) */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Hexadecimal (Base 16)
          </label>
          <input
            type="text"
            value={hexadecimal}
            onChange={(e) => handleHexadecimalChange(e.target.value)}
            placeholder="Enter hexadecimal..."
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
          />
          <div className="mt-1 text-xs text-os-text-muted">
            Valid characters: 0-9, A-F
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Clear Button */}
        <div>
          <button
            onClick={handleClear}
            className="px-4 py-2 bg-os-card text-os-text-primary text-sm rounded-sm border border-os-border hover:bg-os-card-secondary transition-colors"
          >
            Clear All
          </button>
        </div>
      </div>
    </div>
  );
}
