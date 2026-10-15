import { useState } from 'react';
import * as IBAN from 'iban';
import { CheckSquare } from 'lucide-react';

export default function IbanValidatorTool() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);

  const handleValidate = () => {
    const cleanedInput = input.replace(/\s/g, '').toUpperCase();
    const isValid = IBAN.isValid(cleanedInput);

    if (isValid) {
      const formatted = IBAN.printFormat(cleanedInput);
      const country = cleanedInput.substring(0, 2);
      const checkDigits = cleanedInput.substring(2, 4);
      const bban = cleanedInput.substring(4);

      setResult({
        isValid: true,
        formatted: formatted,
        country: country,
        checkDigits: checkDigits,
        bban: bban
      });
    } else {
      setResult({
        isValid: false
      });
    }
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <CheckSquare size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            IBAN Validator
          </h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">IBAN</label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="GB82 WEST 1234 5698 7654 32"
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>
        <button
          onClick={handleValidate}
          disabled={!input}
          className="px-4 py-2 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover disabled:opacity-50 transition-colors"
        >
          Validate
        </button>
        <div>
          {result ? (
            result.isValid ? (
              <div className="space-y-4">
                <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-sm">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-sm font-medium text-green-800 dark:text-green-300">Valid IBAN</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <div className="p-3 bg-os-card border border-os-border rounded-sm">
                    <div className="text-xs text-os-text-secondary">Formatted IBAN</div>
                    <div className="text-sm text-os-text-primary font-mono mt-1">{result.formatted}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 bg-os-card border border-os-border rounded-sm">
                      <div className="text-xs text-os-text-secondary">Country Code</div>
                      <div className="text-sm text-os-text-primary font-mono mt-1">{result.country}</div>
                    </div>
                    <div className="p-3 bg-os-card border border-os-border rounded-sm">
                      <div className="text-xs text-os-text-secondary">Check Digits</div>
                      <div className="text-sm text-os-text-primary font-mono mt-1">{result.checkDigits}</div>
                    </div>
                    <div className="p-3 bg-os-card border border-os-border rounded-sm">
                      <div className="text-xs text-os-text-secondary">BBAN</div>
                      <div className="text-sm text-os-text-primary font-mono mt-1">{result.bban}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="text-sm font-medium text-red-800 dark:text-red-300">Invalid IBAN</span>
                </div>
              </div>
            )
          ) : (
            <div className="p-4 bg-os-card border border-os-border rounded-sm text-center text-sm text-os-text-secondary">
              Validation result will appear here after clicking 'Validate'...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
