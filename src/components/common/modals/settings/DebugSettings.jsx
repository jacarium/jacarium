import { Note, Section, Toggle } from './ui';

/**
 * Settings > Debug: the debug status bar (live FPS plus CPU and memory
 * usage in a corner of every window). The Electron main process owns and
 * persists the state and applies it live - it does not go through Save
 * Settings - so the toggle exists in the desktop app only; the browser
 * deployment says so instead of offering a switch that would do nothing.
 * The props come from SettingsModal, which keeps the state it kept when
 * this lived under General.
 */
export default function DebugSettings({ debugBarEnabled, setDebugBarEnabled }) {
  // The metrics come from the Electron main process, so the toggle is meaningless in web mode.
  const debugBarSupported = typeof window !== 'undefined' && !!window.electronAPI?.setDebugBarEnabled;
  return (
    <Section title="Debug" testId="debug-section">
      {debugBarSupported ? (
        <Toggle label="Show debug status bar" checked={debugBarEnabled === true} onChange={setDebugBarEnabled} testId="debug-status-bar-toggle"
          hint="Live FPS plus CPU and memory usage (this window and the app as a whole) in a small overlay in the bottom-right corner of every window. Applied immediately - no restart needed - and remembered across restarts." />
      ) : (
        <Note testId="debug-desktop-only">The debug status bar is part of the desktop app: its FPS, CPU and memory figures come from the app's own process. There is nothing to switch on in a browser.</Note>
      )}
    </Section>
  );
}
