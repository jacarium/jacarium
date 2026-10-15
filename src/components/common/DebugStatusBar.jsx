import { useEffect, useState } from 'react';

// Debug status bar: a small fixed pill in the bottom-right corner showing
// live FPS, this window's renderer CPU/memory, and the whole app's totals.
// Toggled from Settings > General (default off). The toggle lives in the
// Electron main process (persisted to ui-settings.json) so every window -
// the main shell and each standalone Tools/Diagnostics/etc. window - shows
// or hides the bar together; see the debug-bar section in electron/main.cjs.
//
// CPU/memory arrive over a main-process push ('debug-metrics', one shared 1s
// interval that only exists while the toggle is on). FPS is measured locally
// per window with a requestAnimationFrame counter that only runs while the
// bar is enabled, so the bar costs nothing when off. Chromium throttles rAF
// in hidden/occluded windows, so a background window legitimately reads ~0
// FPS. CPU percentages are relative to a single core (the app total can
// exceed 100%).
//
// Positioning is owned by StatusCorner.jsx (the shared fixed bottom-right
// wrapper it shares with the connection indicator): that wrapper overlays page
// content with pointer-events-none so nothing here ever intercepts clicks
// near the corner, and this bar is just a shrink-to-fit flex item in it.

function formatCpu(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return '--';
  }
  return percent.toFixed(1) + '%';
}

function formatMemory(kb) {
  if (typeof kb !== 'number' || !Number.isFinite(kb)) {
    return '--';
  }
  const mb = kb / 1024;
  if (mb >= 1024) {
    return (mb / 1024).toFixed(2) + ' GB';
  }
  return Math.round(mb) + ' MB';
}

function Stat({ label, children }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-os-text-muted">{label} </span>
      <span className="text-os-text-primary">{children}</span>
    </span>
  );
}

export default function DebugStatusBar() {
  const [enabled, setEnabled] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [fps, setFps] = useState(null);

  // Mirror the main-process toggle: read the current value on mount (the bar
  // can mount into a window opened while the toggle is already on) and stay
  // subscribed for changes made from any window's Settings dialog.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getDebugBarEnabled) {
      return undefined; // web mode: no main process, no bar
    }
    let mounted = true;
    api.getDebugBarEnabled()
      .then((value) => {
        if (mounted) setEnabled(value === true);
      })
      .catch(() => {});
    const cleanup = api.onDebugBarChanged?.((value) => setEnabled(value === true));
    return () => {
      mounted = false;
      cleanup?.();
    };
  }, []);

  // Subscribe to the main-process metrics push only while enabled. The
  // cleanup also clears the last numbers so a later re-enable starts from
  // '--' instead of briefly showing stale values.
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const cleanup = window.electronAPI?.onDebugMetrics?.(setMetrics);
    return () => {
      cleanup?.();
      setMetrics(null);
    };
  }, [enabled]);

  // Local FPS counter: count rAF callbacks and publish roughly once a second
  // (matching the metrics push cadence, and keeping re-renders to ~1/s).
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let rafId;
    let frames = 0;
    let windowStart = performance.now();
    const tick = (now) => {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= 1000) {
        setFps(Math.round((frames * 1000) / elapsed));
        frames = 0;
        windowStart = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      setFps(null);
    };
  }, [enabled]);

  if (!enabled) {
    return null;
  }

  return (
    <div
      role="status"
      aria-label="Debug status bar"
      className="flex items-center gap-4 px-3 py-1 bg-os-card border border-os-border rounded-sm shadow-xs font-mono text-[11px] leading-4 text-os-text-secondary"
    >
      <Stat label="FPS">{fps ?? '--'}</Stat>
      <Stat label="this window">
        {formatCpu(metrics?.window?.cpuPercent)} CPU · {formatMemory(metrics?.window?.memoryKB)}
      </Stat>
      <Stat label={`app total (${metrics?.processCount ?? '--'} processes)`}>
        {formatCpu(metrics?.totalCpuPercent)} CPU · {formatMemory(metrics?.totalMemoryKB)}
      </Stat>
    </div>
  );
}
