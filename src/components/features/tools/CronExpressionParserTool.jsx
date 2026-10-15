import { useState, useEffect, useRef } from 'react';
import { Clock, HelpCircle, List } from 'lucide-react';

export default function CronExpressionParserTool() {
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState('');
  const [nextExecutions, setNextExecutions] = useState([]);
  const [showHelp, setShowHelp] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const helpRef = useRef(null);
  const samplesRef = useRef(null);

  // Close help dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (helpRef.current && !helpRef.current.contains(event.target)) {
        setShowHelp(false);
      }
    };

    if (showHelp) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showHelp]);

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

  const validateCronField = (value, fieldName, min, max) => {
    // Skip validation for wildcards and special characters
    if (value === '*') return true;

    // Extract all numbers from the field (handles ranges, lists, and steps)
    const numbers = [];

    if (value.includes('/')) {
      const [range] = value.split('/');
      if (range !== '*') {
        numbers.push(...range.split(',').flatMap(r => r.includes('-') ? r.split('-') : [r]));
      }
    } else if (value.includes(',')) {
      numbers.push(...value.split(',').flatMap(v => v.includes('-') ? v.split('-') : [v]));
    } else if (value.includes('-')) {
      numbers.push(...value.split('-'));
    } else {
      numbers.push(value);
    }

    // Validate each number
    for (const num of numbers) {
      const n = parseInt(num);
      if (isNaN(n)) {
        throw new Error(`Invalid value "${num}" in ${fieldName}`);
      }
      if (n < min || n > max) {
        throw new Error(`Value "${num}" out of range for ${fieldName} (${min}-${max})`);
      }
    }

    return true;
  };

  const parseCronExpression = () => {
    try {
      setError('');
      const parts = cronExpression.trim().split(/\s+/);

      if (parts.length < 5 || parts.length > 6) {
        setError('Invalid cron expression. Expected 5 or 6 fields.');
        setParsed(null);
        setNextExecutions([]);
        return;
      }

      const hasSeconds = parts.length === 6;
      const [seconds, minute, hour, dayOfMonth, month, dayOfWeek] = hasSeconds
        ? parts
        : ['0', ...parts];

      // Validate each field
      if (hasSeconds && seconds !== '0') {
        validateCronField(seconds, 'Seconds', 0, 59);
      }
      validateCronField(minute, 'Minute', 0, 59);
      validateCronField(hour, 'Hour', 0, 23);
      validateCronField(dayOfMonth, 'Day (Month)', 1, 31);
      validateCronField(month, 'Month', 1, 12);
      validateCronField(dayOfWeek, 'Day (Week)', 0, 6);

      const description = generateDescription({ seconds, minute, hour, dayOfMonth, month, dayOfWeek });
      setParsed({ seconds, minute, hour, dayOfMonth, month, dayOfWeek, description });

      // Calculate next 5 execution times
      const next = calculateNextExecutions({ seconds, minute, hour, dayOfMonth, month, dayOfWeek });
      setNextExecutions(next);
    } catch (err) {
      setError(err.message || 'Failed to parse cron expression');
      setParsed(null);
      setNextExecutions([]);
    }
  };

  const generateDescription = ({ seconds, minute, hour, dayOfMonth, month, dayOfWeek }) => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Helper to format time
    const formatTime = (h, m) => {
      const hourNum = parseInt(h);
      const minNum = parseInt(m);
      const period = hourNum >= 12 ? 'PM' : 'AM';
      const hour12 = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
      const minuteStr = minNum === 0 ? '' : `:${String(minNum).padStart(2, '0')}`;

      if (hourNum === 0 && minNum === 0) return 'midnight';
      if (hourNum === 12 && minNum === 0) return 'noon';
      return `${hour12}${minuteStr} ${period}`;
    };

    // Check for common patterns first
    if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      if (seconds === '*') return 'Every second';
      return 'Every minute';
    }

    if (minute.includes('/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      const interval = minute.split('/')[1];
      return `Every ${interval} minutes`;
    }

    if (minute === '0' && hour.includes('/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      const interval = hour.split('/')[1];
      return `Every ${interval} hours`;
    }

    if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      return 'Every hour';
    }

    // Build description with time
    let desc = '';

    // Time portion
    if (hour !== '*' && !hour.includes('/')) {
      if (minute === '*') {
        // Every minute during specific hour(s)
        if (hour.includes(',')) {
          const hours = hour.split(',').map(h => {
            const hourNum = parseInt(h);
            const period = hourNum >= 12 ? 'PM' : 'AM';
            const hour12 = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
            return `${hour12} ${period}`;
          }).join(' and ');
          desc = `Every minute during ${hours} hours`;
        } else {
          const hourNum = parseInt(hour);
          const period = hourNum >= 12 ? 'PM' : 'AM';
          const hour12 = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
          desc = `Every minute during ${hour12} ${period} hour`;
        }
      } else if (minute.includes(',')) {
        const minutes = minute.split(',').map(m => formatTime(hour, m)).join(', ');
        desc = `At ${minutes}`;
      } else if (hour.includes(',')) {
        const times = hour.split(',').map(h => formatTime(h, minute)).join(' and ');
        desc = `At ${times}`;
      } else {
        desc = `At ${formatTime(hour, minute)}`;
      }
    } else if (hour.includes('/')) {
      const interval = hour.split('/')[1];
      desc = `Every ${interval} hours`;
    } else if (minute !== '*' && hour === '*') {
      // Specific minute every hour
      desc = `At minute ${minute} of every hour`;
    }

    // Day of week
    if (dayOfWeek !== '*') {
      if (dayOfWeek.includes(',')) {
        const days = dayOfWeek.split(',').map(d => dayNames[parseInt(d)]).join(', ');
        desc += desc ? ` on ${days}` : `Every ${days}`;
      } else if (dayOfWeek.includes('-')) {
        const [start, end] = dayOfWeek.split('-');
        if (start === '1' && end === '5') {
          desc += desc ? ' on weekdays' : 'Every weekday';
        } else {
          desc += desc ? ` on ${dayNames[parseInt(start)]} through ${dayNames[parseInt(end)]}` : `Every ${dayNames[parseInt(start)]} through ${dayNames[parseInt(end)]}`;
        }
      } else {
        desc += desc ? ` on ${dayNames[parseInt(dayOfWeek)]}` : `Every ${dayNames[parseInt(dayOfWeek)]}`;
      }
    } else if (dayOfMonth !== '*') {
      // Day of month (only if day of week is not set)
      if (dayOfMonth.includes(',')) {
        const days = dayOfMonth.split(',').join(', ');
        desc += ` on the ${days}${getDaySuffix(dayOfMonth.split(',')[0])} of the month`;
      } else if (dayOfMonth === '1') {
        desc += ' on the 1st of the month';
      } else if (dayOfMonth === '15') {
        desc += ' on the 15th of the month';
      } else {
        desc += ` on day ${dayOfMonth} of the month`;
      }
    } else if (!desc) {
      desc = 'Every day';
    }

    // Month
    if (month !== '*') {
      if (month.includes(',')) {
        const months = month.split(',').map(m => monthNames[parseInt(m) - 1]).join(', ');
        desc += ` in ${months}`;
      } else {
        desc += ` in ${monthNames[parseInt(month) - 1]}`;
      }
    }

    return desc || 'Invalid expression';
  };

  const getDaySuffix = (day) => {
    const d = parseInt(day);
    if (d >= 11 && d <= 13) return 'th';
    switch (d % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  };

  const calculateNextExecutions = ({ seconds, minute, hour, dayOfMonth, month, dayOfWeek }) => {
    const executions = [];
    const now = new Date();
    let current = new Date(now);

    // Simplified calculation - advance minute by minute and check if it matches
    const maxIterations = 100000; // Prevent infinite loops
    let iterations = 0;

    while (executions.length < 5 && iterations < maxIterations) {
      iterations++;
      current = new Date(current.getTime() + 60000); // Add 1 minute

      const sec = parseInt(seconds === '*' ? '0' : seconds.split('/')[0].split(',')[0]);
      const min = current.getMinutes();
      const hr = current.getHours();
      const dom = current.getDate();
      const mon = current.getMonth() + 1;
      const dow = current.getDay();

      if (!matchesCronField(min, minute)) continue;
      if (!matchesCronField(hr, hour)) continue;
      if (!matchesCronField(dom, dayOfMonth)) continue;
      if (!matchesCronField(mon, month)) continue;
      if (dayOfWeek !== '*' && !matchesCronField(dow, dayOfWeek)) continue;

      executions.push(new Date(current.getFullYear(), current.getMonth(), current.getDate(), hr, min, sec));
    }

    return executions;
  };

  const matchesCronField = (value, field) => {
    if (field === '*') return true;

    if (field.includes('/')) {
      const [start, interval] = field.split('/');
      const startVal = start === '*' ? 0 : parseInt(start);
      return (value - startVal) % parseInt(interval) === 0 && value >= startVal;
    }

    if (field.includes(',')) {
      return field.split(',').map(v => parseInt(v)).includes(value);
    }

    if (field.includes('-')) {
      const [start, end] = field.split('-').map(v => parseInt(v));
      return value >= start && value <= end;
    }

    return parseInt(field) === value;
  };

  // Re-parse whenever the expression changes. The parse also computes the
  // next execution times from the current clock, so an effect (not a
  // render-time memo) is the appropriate home for it. parseCronExpression
  // is recreated per render but only reads cronExpression, which is
  // already the dependency.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    parseCronExpression();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cronExpression]);

  const examples = [
    { expr: '* * * * *', desc: 'Every minute' },
    { expr: '*/5 * * * *', desc: 'Every 5 minutes' },
    { expr: '*/15 * * * *', desc: 'Every 15 minutes' },
    { expr: '0 * * * *', desc: 'Every hour' },
    { expr: '0 */2 * * *', desc: 'Every 2 hours' },
    { expr: '0 0 * * *', desc: 'Every day at midnight' },
    { expr: '0 9 * * 1-5', desc: 'Weekdays at 9 AM' },
    { expr: '0 9,17 * * *', desc: 'At 9 AM and 5 PM' },
    { expr: '0 0 * * 0', desc: 'Every Sunday at midnight' },
    { expr: '0 0 1 * *', desc: 'First day of every month' },
    { expr: '30 4 1,15 * *', desc: '4:30 AM on 1st and 15th' },
    { expr: '0 0 1 1 *', desc: 'Every January 1st' },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6 overflow-auto">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Clock size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Cron Parser
          </h3>
        </div>

        <p className="text-sm text-os-text-secondary">
          Parse and understand cron expressions with human-readable descriptions
        </p>

        {/* Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <label className="text-sm text-os-text-primary">
                Cron Expression
              </label>
              <div className="relative" ref={helpRef}>
                <button
                  onClick={() => setShowHelp(!showHelp)}
                  className="text-os-text-secondary hover:text-os-text-primary transition-colors"
                  title="Format Help"
                >
                  <HelpCircle size={16} />
                </button>
                {showHelp && (
                  <div className="absolute left-0 top-full mt-1 w-96 px-4 py-3 bg-os-card border border-os-border rounded-sm shadow-lg z-10">
                    <div className="text-sm text-os-text-secondary space-y-1">
                      <p><code className="text-os-text-primary font-mono">*</code> - Any value</p>
                      <p><code className="text-os-text-primary font-mono">,</code> - List separator (e.g., 1,3,5)</p>
                      <p><code className="text-os-text-primary font-mono">-</code> - Range (e.g., 1-5)</p>
                      <p><code className="text-os-text-primary font-mono">/</code> - Step values (e.g., */15 = every 15)</p>
                      <p className="mt-2 pt-2 border-t border-os-border">Day of week: 0 = Sunday, 1 = Monday, 2 = Tuesday, 3 = Wednesday, 4 = Thursday, 5 = Friday, 6 = Saturday</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="relative" ref={samplesRef}>
              <button
                onClick={() => setShowSamples(!showSamples)}
                className="flex items-center gap-1 px-3 py-1 text-xs text-os-text-secondary hover:text-os-text-primary bg-os-card border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors"
              >
                Samples
              </button>
              {showSamples && (
                <div className="absolute right-0 top-full mt-1 w-80 bg-os-card border border-os-border rounded-sm shadow-lg z-10">
                  <div className="p-1">
                    {examples.map((example, index) => (
                      <button
                        key={index}
                        onClick={() => {
                          setCronExpression(example.expr);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <code className="text-xs text-os-text-primary font-mono">{example.expr}</code>
                          <span className="text-xs text-os-text-muted">{example.desc}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <input
            type="text"
            value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:ring-2 focus:ring-os-blue font-mono text-sm"
          />
        </div>

        {/* Field Breakdown */}
        {parsed && (
          <div className="grid grid-cols-5 gap-2">
            {parsed.seconds !== '0' && (
              <div>
                <div className="text-xs text-os-text-muted mb-1">Seconds</div>
                <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-center">
                  <span className="text-sm text-os-text-primary font-mono">{parsed.seconds}</span>
                </div>
              </div>
            )}
            <div>
              <div className="text-xs text-os-text-muted mb-1">Minute</div>
              <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-center">
                <span className="text-sm text-os-text-primary font-mono">{parsed.minute}</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-os-text-muted mb-1">Hour</div>
              <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-center">
                <span className="text-sm text-os-text-primary font-mono">{parsed.hour}</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-os-text-muted mb-1">Day of Month</div>
              <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-center">
                <span className="text-sm text-os-text-primary font-mono">{parsed.dayOfMonth}</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-os-text-muted mb-1">Month</div>
              <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-center">
                <span className="text-sm text-os-text-primary font-mono">{parsed.month}</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-os-text-muted mb-1">Day of Week</div>
              <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-center">
                <span className="text-sm text-os-text-primary font-mono">{parsed.dayOfWeek}</span>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-sm">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Description */}
        {parsed && (
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Description
            </label>
            <div className="px-4 py-3 bg-os-card border border-os-border rounded-sm">
              <p className="text-sm text-os-text-primary">{parsed.description}</p>
            </div>
          </div>
        )}

        {/* Next Executions */}
        {nextExecutions.length > 0 && (
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Next 5 Executions
            </label>
            <div className="space-y-2">
              {nextExecutions.map((date, index) => (
                <div key={index} className="px-3 py-2 bg-os-card border border-os-border rounded-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-os-text-muted">Execution {index + 1}</span>
                    <span className="text-sm text-os-text-primary font-mono">
                      {date.toLocaleString('en-US', {
                        weekday: 'short',
                        year: 'numeric',
                        month: 'short',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
