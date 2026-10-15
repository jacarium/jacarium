import DebugStatusBar from './DebugStatusBar';
import ConnectionIndicator from './ConnectionIndicator';
import HomeServerVersionNotice from './HomeServerVersionNotice';

// The bottom-right status corner shared by every window: the home-server
// version notice, the debug status bar (FPS / CPU / memory, Settings >
// General) and the connection indicator (online / offline against the home
// server, src/components/common/ConnectionIndicator.jsx).
//
// This wrapper is the ONLY thing that is position: fixed. The children are
// plain flex items, so whichever of them are showing sit side by side with a
// fixed gap, the indicator in the corner and the bar to its left; when the
// bar is toggled off (live, from any window's Settings dialog) it renders
// null and the indicator slides into place - no per-component offsets to
// keep in sync. pointer-events-none on the wrapper so it never intercepts
// clicks near the corner (the children opt back in for their tooltips and
// clicks), and z-40 - below toasts/modals, which stack higher.
export default function StatusCorner() {
  return (
    <div
      data-testid="status-corner"
      className="fixed bottom-2 right-2 z-40 pointer-events-none flex items-center gap-2"
    >
      <HomeServerVersionNotice />
      <DebugStatusBar />
      <ConnectionIndicator />
    </div>
  );
}
