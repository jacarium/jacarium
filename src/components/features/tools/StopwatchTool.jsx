import { useState, useEffect, useRef } from 'react';
import { Clock } from 'lucide-react';

export default function StopwatchTool() {
  const [time, setTime] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [laps, setLaps] = useState([]);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (isRunning) {
      intervalRef.current = setInterval(() => {
        setTime(prev => prev + 10);
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
  }, [isRunning]);

  const formatTime = (ms) => {
    const milliseconds = Math.floor((ms % 1000) / 10);
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));

    return {
      hours: String(hours).padStart(2, '0'),
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
      milliseconds: String(milliseconds).padStart(2, '0')
    };
  };

  const handleStart = () => {
    setIsRunning(true);
  };

  const handlePause = () => {
    setIsRunning(false);
  };

  const handleReset = () => {
    setIsRunning(false);
    setTime(0);
    setLaps([]);
  };

  const handleLap = () => {
    setLaps(prev => [...prev, time]);
  };

  const formatted = formatTime(time);

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Clock size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Stopwatch
          </h3>
        </div>

        <div className="p-8 bg-os-card border border-os-border rounded-sm text-center">
          <div className="text-6xl font-bold text-os-text-primary font-mono">
            {formatted.hours}:{formatted.minutes}:{formatted.seconds}.{formatted.milliseconds}
          </div>
        </div>
        <div className="flex gap-2 justify-center">
          {!isRunning ? (
            <button
              onClick={handleStart}
              className="px-6 py-3 bg-os-blue text-white text-sm rounded-sm hover:bg-os-blue-hover transition-colors"
            >
              {time > 0 ? 'Resume' : 'Start'}
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
            onClick={handleLap}
            disabled={!isRunning}
            className="px-6 py-3 bg-os-card border border-os-border text-os-text-primary text-sm rounded-sm hover:bg-os-border disabled:opacity-50 transition-colors"
          >
            Lap
          </button>
          <button
            onClick={handleReset}
            className="px-6 py-3 bg-os-card border border-os-border text-os-text-primary text-sm rounded-sm hover:bg-os-border transition-colors"
          >
            Reset
          </button>
        </div>
        <div>
          <h4 className="text-sm font-medium text-os-text-primary mb-2">Laps</h4>
          <div className="bg-os-card border border-os-border rounded-sm overflow-hidden">
            {laps.length > 0 ? (
              <div className="max-h-64 overflow-auto">
                {laps.map((lap, index) => {
                  const lapFormatted = formatTime(lap);
                  const lapTime = index > 0 ? formatTime(lap - laps[index - 1]) : formatTime(lap);
                  return (
                    <div key={index} className="flex justify-between px-4 py-2 border-b border-os-border last:border-b-0 hover:bg-os-border">
                      <span className="text-sm text-os-text-secondary">Lap {index + 1}</span>
                      <div className="flex gap-4">
                        <span className="text-sm text-os-text-primary font-mono">
                          {lapTime.hours}:{lapTime.minutes}:{lapTime.seconds}.{lapTime.milliseconds}
                        </span>
                        <span className="text-sm text-os-text-secondary font-mono">
                          {lapFormatted.hours}:{lapFormatted.minutes}:{lapFormatted.seconds}.{lapFormatted.milliseconds}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-sm text-os-text-secondary">
                Lap times will appear here
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
