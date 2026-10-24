import { useState } from 'react';
import { Calculator } from 'lucide-react';

/**
 * SlaCalculatorTool - SLA uptime calculator
 *
 * Calculate allowed downtime based on SLA percentage
 */
export default function SlaCalculatorTool() {
  const [slaPercent, setSlaPercent] = useState('99.9');
  const [results, setResults] = useState(null);

  const calculateDowntime = (sla) => {
    const uptimePercent = parseFloat(sla);
    if (isNaN(uptimePercent) || uptimePercent < 0 || uptimePercent > 100) {
      setResults(null);
      return;
    }

    const downtimePercent = 100 - uptimePercent;

    const minutesPerDay = 24 * 60;
    const minutesPerWeek = minutesPerDay * 7;
    const minutesPerMonth = minutesPerDay * 30.44; // Average month
    const minutesPerQuarter = minutesPerMonth * 3;
    const minutesPerYear = minutesPerDay * 365.25;

    const calculateTime = (totalMinutes) => {
      const downMinutes = (totalMinutes * downtimePercent) / 100;

      const days = Math.floor(downMinutes / (24 * 60));
      const hours = Math.floor((downMinutes % (24 * 60)) / 60);
      const minutes = Math.floor(downMinutes % 60);
      const seconds = Math.floor((downMinutes % 1) * 60);

      return {
        total: downMinutes,
        days,
        hours,
        minutes,
        seconds,
        formatted: formatTime(days, hours, minutes, seconds)
      };
    };

    const formatTime = (d, h, m, s) => {
      const parts = [];
      if (d > 0) parts.push(`${d}d`);
      if (h > 0) parts.push(`${h}h`);
      if (m > 0) parts.push(`${m}m`);
      if (s > 0) parts.push(`${s}s`);
      return parts.join(' ') || '0s';
    };

    setResults({
      daily: calculateTime(minutesPerDay),
      weekly: calculateTime(minutesPerWeek),
      monthly: calculateTime(minutesPerMonth),
      quarterly: calculateTime(minutesPerQuarter),
      yearly: calculateTime(minutesPerYear)
    });
  };

  const handleSlaChange = (value) => {
    setSlaPercent(value);
    calculateDowntime(value);
  };

  const commonSlas = [
    { label: '90% (One Nine)', value: '90' },
    { label: '95% (One and a Half Nines)', value: '95' },
    { label: '99% (Two Nines)', value: '99' },
    { label: '99.5% (Two and a Half Nines)', value: '99.5' },
    { label: '99.9% (Three Nines)', value: '99.9' },
    { label: '99.95% (Three and a Half Nines)', value: '99.95' },
    { label: '99.99% (Four Nines)', value: '99.99' },
    { label: '99.999% (Five Nines)', value: '99.999' }
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Calculator size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            SLA Calculator
          </h3>
        </div>

        <p className="text-sm text-os-text-secondary">
          Calculate allowed downtime based on SLA uptime percentage
        </p>

        {/* Input */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              SLA Uptime Percentage
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="0.001"
                value={slaPercent}
                onChange={(e) => handleSlaChange(e.target.value)}
                className="flex-1 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
                placeholder="99.9"
              />
              <span className="flex items-center px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary">
                %
              </span>
            </div>
          </div>

          {/* Common SLAs */}
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Common SLA Levels
            </label>
            <div className="grid grid-cols-2 gap-2">
              {commonSlas.map(({ label, value }) => (
                <button
                  key={value}
                  onClick={() => handleSlaChange(value)}
                  className={`px-3 py-2 text-sm border transition-colors text-left ${
 slaPercent === value
 ?'btn-selected'
 :'bg-os-card text-os-text-primary border-os-border hover:bg-os-card-secondary'
 }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Results */}
        <div>
          <label className="block text-sm text-os-text-primary mb-3">
            Allowed Downtime
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="px-4 py-3 bg-os-card border border-os-border rounded-sm">
              <div className="text-xs text-os-text-muted mb-1">Daily</div>
              <div className="text-lg font-semibold text-os-text-primary">
                {results ? results.daily.formatted : '-'}
              </div>
            </div>
            <div className="px-4 py-3 bg-os-card border border-os-border rounded-sm">
              <div className="text-xs text-os-text-muted mb-1">Weekly</div>
              <div className="text-lg font-semibold text-os-text-primary">
                {results ? results.weekly.formatted : '-'}
              </div>
            </div>
            <div className="px-4 py-3 bg-os-card border border-os-border rounded-sm">
              <div className="text-xs text-os-text-muted mb-1">Monthly</div>
              <div className="text-lg font-semibold text-os-text-primary">
                {results ? results.monthly.formatted : '-'}
              </div>
            </div>
            <div className="px-4 py-3 bg-os-card border border-os-border rounded-sm">
              <div className="text-xs text-os-text-muted mb-1">Quarterly</div>
              <div className="text-lg font-semibold text-os-text-primary">
                {results ? results.quarterly.formatted : '-'}
              </div>
            </div>
            <div className="px-4 py-3 bg-os-card border border-os-border rounded-sm md:col-span-2">
              <div className="text-xs text-os-text-muted mb-1">Yearly</div>
              <div className="text-lg font-semibold text-os-text-primary">
                {results ? results.yearly.formatted : '-'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
