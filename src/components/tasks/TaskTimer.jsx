import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';

/**
 * TaskTimer - Shows elapsed time for active tasks
 * @param {string} startTime - ISO timestamp when task started
 * @param {string} className - Optional CSS classes
 */
export default function TaskTimer({ startTime, className = '' }) {
  const [elapsed, setElapsed] = useState('00:00:00');

  useEffect(() => {
    // No timer running: state already resets to 00:00:00 via the cleanup
    // below when startTime goes away (and the initial state covers mount).
    if (!startTime) return undefined;

    const updateElapsed = () => {
      try {
        const start = new Date(startTime);
        const now = new Date();
        const diff = now - start;

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        setElapsed(
          `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        );
      } catch (error) {
        console.error('[TaskTimer] Error updating elapsed time:', error);
      }
    };

    // Update immediately
    updateElapsed();

    // Update every second
    const interval = setInterval(updateElapsed, 1000);

    return () => {
      if (interval) {
        clearInterval(interval);
      }
      // Reset the display so the next timer starts from zero instead of
      // flashing the previous elapsed value
      setElapsed('00:00:00');
    };
  }, [startTime]);

  if (!startTime) {
    return null;
  }

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <Clock size={11} className="text-green-700 dark:text-green-400 animate-pulse" />
      <span className="text-[11px] font-mono text-green-700 dark:text-green-400 font-medium">
        {elapsed}
      </span>
    </div>
  );
}
