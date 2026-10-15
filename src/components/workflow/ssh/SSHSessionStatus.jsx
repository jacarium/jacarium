/** "Connected" / "Exit: N" chips shown in the terminal's header or status bar. */
export default function SSHSessionStatus({ isConnected, exitCode }) {
  return (
    <>
      {isConnected && (
        <span className="flex items-center gap-1 text-xs text-os-text-secondary">
          <span className="w-2 h-2 bg-green-500 rounded-full"></span>
          Connected
        </span>
      )}
      {exitCode !== null && (
        <span className={`flex items-center gap-1 text-xs ${
 exitCode === 0 ?'text-green-500':'text-red-500'
 }`}>
          <span className={`w-2 h-2 rounded-full ${
 exitCode === 0 ?'bg-green-500':'bg-red-500'
 }`}></span>
          Exit: {exitCode}
        </span>
      )}
    </>
  );
}
