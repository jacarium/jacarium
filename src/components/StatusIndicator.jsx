export default function StatusIndicator({ status = 'success', label }) {
  const colors = {
    success: 'bg-status-success',
    warning: 'bg-status-warning',
    danger: 'bg-status-danger',
  };

  const textColors = {
    success: 'text-status-success',
    warning: 'text-status-warning',
    danger: 'text-status-danger',
  };

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${colors[status]}`}></div>
      <span className={`text-xs font-medium ${textColors[status]}`}>{label}</span>
    </div>
  );
}
