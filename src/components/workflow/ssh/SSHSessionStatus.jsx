/** "Connected" / "Exit: N" chips shown in the terminal's header or status bar. */
export default function SSHSessionStatus({ isConnected, exitCode }) {
  return (
    <>
      {isConnected && (
        <span className="flex items-center gap-1 text-xs text-os-text-secondary">
          <span className="w-2 h-2 bg-(--chart-good) rounded-full"></span>
          Connected
        </span>
      )}
      {exitCode !== null && (
        <span className={`flex items-center gap-1 text-xs ${
 exitCode === 0 ?'text-(--chart-good)':'text-(--chart-bad)'
 }`}>
          <span className={`w-2 h-2 rounded-full ${
 exitCode === 0 ?'bg-(--chart-good)':'bg-(--chart-bad)'
 }`}></span>
          Exit: {exitCode}
        </span>
      )}
    </>
  );
}
