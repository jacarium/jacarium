import { useState } from 'react';
import { Clock } from 'lucide-react';

export default function TimeFormatConverterTool() {
  const [inputTime, setInputTime] = useState('');
  const [inputType, setInputType] = useState('unix');
  const [results, setResults] = useState(null);

  const parseInput = (value) => {
    const timeValue = value !== undefined ? value : inputTime;

    if (!timeValue) {
      setResults(null);
      return;
    }

    let date;
    try {
      switch (inputType) {
        case 'unix':
          date = new Date(parseInt(timeValue) * 1000);
          break;
        case 'milliseconds':
          date = new Date(parseInt(timeValue));
          break;
        case 'iso8601':
        case 'rfc2822':
        case 'http':
        case 'sql':
          date = new Date(timeValue);
          break;
        default:
          date = new Date(timeValue);
      }

      if (isNaN(date.getTime())) {
        setResults(null);
        return;
      }

      setResults({
        unix: Math.floor(date.getTime() / 1000),
        milliseconds: date.getTime(),
        iso8601Local: date.toISOString().replace('Z', date.toString().match(/GMT([+-]\d{4})/)?.[1] || ''),
        iso8601UTC: date.toISOString(),
        relative: getRelativeTime(date),
        rfc2822: date.toUTCString(),
        http: date.toUTCString(),
        local: date.toLocaleString(),
        sql: date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
        yyyymmdd: date.toISOString().split('T')[0],
        ddmmyyyy: `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
    } catch {
      setResults(null);
    }
  };

  const getRelativeTime = (date) => {
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(Math.abs(diff) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days !== 1 ? 's' : ''} ${diff > 0 ? 'ago' : 'from now'}`;
    if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} ${diff > 0 ? 'ago' : 'from now'}`;
    if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''} ${diff > 0 ? 'ago' : 'from now'}`;
    return `${seconds} second${seconds !== 1 ? 's' : ''} ${diff > 0 ? 'ago' : 'from now'}`;
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        <div className="flex items-center gap-2">
          <Clock size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">Time Format Converter</h3>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Input Type</label>
          <select value={inputType} onChange={(e) => { setInputType(e.target.value); setTimeout(() => parseInput(inputTime), 0); }} className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue">
            <option value="unix">Unix Time (seconds)</option>
            <option value="milliseconds">Milliseconds</option>
            <option value="iso8601">ISO 8601</option>
            <option value="sql">SQL</option>
            <option value="rfc2822">RFC 2822</option>
            <option value="http">HTTP</option>
          </select>
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Input Time</label>
          <input
            type="text"
            value={inputTime}
            onChange={(e) => {
              setInputTime(e.target.value);
              parseInput(e.target.value);
            }}
            placeholder="Enter time value..."
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>

        <div>
          <label className="block text-sm text-os-text-primary mb-2">Converted Formats</label>
          {results ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Object.entries({
                'Unix Time': results.unix,
                'Milliseconds': results.milliseconds,
                'Local (ISO 8601)': results.iso8601Local,
                'UTC (ISO 8601)': results.iso8601UTC,
                'Relative': results.relative,
                'RFC 2822': results.rfc2822,
                'HTTP': results.http,
                'Local': results.local,
                'SQL': results.sql,
                'YYYY-MM-DD': results.yyyymmdd,
                'DD/MM/YYYY': results.ddmmyyyy,
                'Timezone': results.timezone
              }).map(([label, value]) => (
                <div key={label} className="px-3 py-2 bg-os-card border border-os-border rounded-sm">
                  <div className="text-xs text-os-text-muted mb-1">{label}</div>
                  <div className="text-sm text-os-text-primary font-mono break-all">{value}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 bg-os-card border border-os-border rounded-sm text-center text-sm text-os-text-secondary">
              Time conversions will appear here after entering a time value
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
