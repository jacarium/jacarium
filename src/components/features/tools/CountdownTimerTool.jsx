import { useState, useEffect, useRef } from 'react';
import { Clock } from 'lucide-react';

export default function CountdownTimerTool() {
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0); // in milliseconds
  const [isActive, setIsActive] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (isActive && timeLeft > 0) {
      intervalRef.current = setInterval(() => {
        setTimeLeft(prev => {
          const newTime = prev - 10;
          if (newTime <= 0) {
            setIsActive(false);
            return 0;
          }
          return newTime;
        });
      }, 10);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isActive, timeLeft]);

  const handleStart = () => {
    if (timeLeft > 0) {
      // Resume from current time
      setIsActive(true);
    } else {
      // Start with new time
      const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
      if (totalMs > 0) {
        setTimeLeft(totalMs);
        setIsActive(true);
      }
    }
  };

  const handlePause = () => {
    setIsActive(false);
  };

  const handleReset = () => {
    setIsActive(false);
    setTimeLeft(0);
  };

  const formatTime = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const milliseconds = Math.floor((ms % 1000) / 10);

    return {
      hours: String(h).padStart(2, '0'),
      minutes: String(m).padStart(2, '0'),
      seconds: String(s).padStart(2, '0'),
      milliseconds: String(milliseconds).padStart(2, '0')
    };
  };

  const formatted = formatTime(timeLeft);

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Clock size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Countdown Timer
          </h3>
        </div>

        {!isActive && timeLeft === 0 && (
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Set Time (H:M:S)</label>
            <div className="flex gap-2 items-center">
              <input
                type="number"
                min="0"
                max="99"
                value={hours}
                onChange={(e) => setHours(Math.max(0, Math.min(99, parseInt(e.target.value) || 0)))}
                placeholder="HH"
                className="w-20 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center font-mono text-lg focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              />
              <span className="text-lg text-os-text-primary">:</span>
              <input
                type="number"
                min="0"
                max="59"
                value={minutes}
                onChange={(e) => setMinutes(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                placeholder="MM"
                className="w-20 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center font-mono text-lg focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              />
              <span className="text-lg text-os-text-primary">:</span>
              <input
                type="number"
                min="0"
                max="59"
                value={seconds}
                onChange={(e) => setSeconds(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                placeholder="SS"
                className="w-20 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center font-mono text-lg focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              />
            </div>
          </div>
        )}

        <div className="p-8 bg-os-card border border-os-border rounded-sm text-center">
          <div className="text-6xl font-bold text-os-text-primary font-mono">
            {formatted.hours}:{formatted.minutes}:{formatted.seconds}.{formatted.milliseconds}
          </div>
        </div>

        <div className="flex gap-2 justify-center">
          {!isActive ? (
            <button
              onClick={handleStart}
              disabled={timeLeft === 0 && hours === 0 && minutes === 0 && seconds === 0}
              className="px-6 py-3 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover disabled:opacity-50 transition-colors"
            >
              {timeLeft > 0 ? 'Resume' : 'Start'}
            </button>
          ) : (
            <button
              onClick={handlePause}
              className="px-6 py-3 bg-yellow-500 text-white text-sm rounded-sm hover:bg-yellow-600 transition-colors"
            >
              Pause
            </button>
          )}
          <button
            onClick={handleReset}
            className="px-6 py-3 bg-os-card border border-os-border text-os-text-primary text-sm rounded-sm hover:bg-os-border transition-colors"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
