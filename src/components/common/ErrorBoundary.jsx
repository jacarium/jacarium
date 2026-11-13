import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/primitives';
import { NOTIFY_EVENT } from '../../contexts/NotificationContext';

/**
 * The shared error boundary: one render error can never blank the whole
 * app. The root, the shell's page slot and every portalled layer (menus,
 * popovers, dialogs, floating windows) sit inside one, so a popup that
 * throws shows a small fallback where it would have been while the rail
 * and the rest keep working; the page slot's fallback offers "Reload this
 * view" (the boundary resets and the page mounts again), the root's as
 * well as "Reload the app". Every catch goes to the console (with the
 * component stack) and to the notification channel (NOTIFY_EVENT: the
 * bell's history keeps it, so the error is still there after the view
 * was reloaded). Theme tokens only.
 *
 * @param {'app'|'page'|'popup'} [scope='page']  what the boundary guards: the
 *   fallback's size and wording follow it
 * @param {string} [label]  what the fallback calls it ("this menu", "Documents")
 * @param {() => void} [onReset]  called when the fallback's reload resets the boundary (a popup's owner closes it)
 * @param {Array} [resetKeys]  when any of these changes, a shown fallback resets (the page changed)
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, gaveUp: false };
    this.lastAutoReset = 0;
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error: error || new Error('unknown error') };
  }

  componentDidCatch(error, info) {
    const { scope = 'page', label } = this.props;
    const where = label || (scope === 'app' ? 'the app' : scope === 'popup' ? 'a menu' : 'this page');
    const message = error && error.message ? String(error.message) : String(error);
    console.error(`[ErrorBoundary] ${where} failed to render: ${message}`, error, info && info.componentStack);
    try {
      window.dispatchEvent(new CustomEvent(NOTIFY_EVENT, { detail: { type: 'error', title: `Something went wrong in ${where}`, message: `${message}${info && info.componentStack ? '\n' + String(info.componentStack).trim().split('\n').slice(0, 4).join('\n') : ''}` } }));
    } catch { /* no window (a test without one) */ }
    if (typeof this.props.onError === 'function') this.props.onError(error, info);
  }

  componentDidUpdate(prevProps) {
    const { resetKeys } = this.props;
    if (!this.state.error || !Array.isArray(resetKeys) || !Array.isArray(prevProps.resetKeys)) return;
    if (resetKeys.length === prevProps.resetKeys.length && resetKeys.every((k, i) => Object.is(k, prevProps.resetKeys[i]))) return;
    // a reset that threw again straight away is not retried by itself: one automatic retry per second at most, so a
    // child that throws on every mount can never spin the boundary (reset -> throw -> reset ...) - the fallback
    // stays until a person clicks Reload, which always tries once more
    const now = Date.now();
    if (this.lastAutoReset && now - this.lastAutoReset < 1000) { this.setState({ gaveUp: true }); return; }
    this.lastAutoReset = now;
    this.reset();
  }

  reset() {
    this.setState({ error: null, gaveUp: false });
    if (typeof this.props.onReset === 'function') this.props.onReset();
  }

  render() {
    const { error, gaveUp } = this.state;
    if (!error) return this.props.children;
    const { scope = 'page', label, fallback } = this.props;
    if (fallback) return typeof fallback === 'function' ? fallback({ error, reset: this.reset }) : fallback;
    const message = error && error.message ? String(error.message) : String(error);
    if (scope === 'popup') {
      return (
        <div role="alert" data-testid="error-boundary" data-scope="popup" className="fixed left-1/2 top-16 -translate-x-1/2 z-[2147483647] max-w-sm rounded-lg border border-os-border bg-os-card px-3 py-2 text-xs text-os-text-primary shadow-lg flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0 text-(--status-danger-fg)" aria-hidden="true" />
          <span className="min-w-0 flex-1">{label || 'This menu'} could not open: {message}</span>
          <Button variant="ghost" size="sm" onClick={this.reset} className="shrink-0">Close</Button>
        </div>
      );
    }
    return (
      <div role="alert" data-testid="error-boundary" data-scope={scope} data-gave-up={gaveUp ? 'true' : undefined} className="flex h-full w-full min-h-[12rem] items-center justify-center p-6 bg-os-canvas text-os-text-primary">
        <div className="max-w-md w-full rounded-lg border border-os-border bg-os-card p-5 shadow-lg">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle size={18} className="shrink-0 text-(--status-danger-fg)" aria-hidden="true" />
            Something went wrong{label ? ` in ${label}` : ''}
          </div>
          <p className="mt-2 text-xs text-os-text-secondary break-words">{message}</p>
          <p className="mt-1 text-xs text-os-text-muted">{gaveUp ? 'It failed again right after a retry, so it stays here until you reload it. ' : 'The rest of the app keeps working. '}Reload this view to try again; the error is kept in the notifications.</p>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" size="sm" onClick={this.reset} data-testid="error-boundary-reset">Reload this view</Button>
            {scope === 'app' && (
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload the app</Button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
