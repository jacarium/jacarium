/**
 * NoticeBanner - the slim full-width notice strip the Documents editor shows
 * above a document (offline / read-only / server copy unavailable), shared
 * so other pages (the Tasks page's orphaned-tasks notice) render the very
 * same thing instead of copying the markup.
 *
 * Markup and classes are exactly the DocumentEditor banners': a tinted strip
 * (Tailwind colour scale with dark: variants, readable in both themes), a
 * small stroked icon, an optional bold lead-in and the message.
 *
 * Props:
 *   tone      'warning' (amber, default) | 'readonly' (purple) | 'offline' (orange)
 *             | 'info' (blue: a status such as "Updated from another device")
 *   title     optional bold lead-in ("Read-only:")
 *   children  the message (text, or spans/buttons)
 *   testId    data-testid for tests
 *   role      ARIA role; defaults to "status" (polite live region)
 *   className extra classes on the strip
 *   onDismiss when given, a small x at the right end closes the banner
 *
 * NoticeBannerAction is the text-style (underlined, no box) action button
 * for use inside a banner: inherits the banner's text colour, keyboard
 * focusable with a visible focus ring, and disables while `busy`.
 */

const TONES = {
  warning: {
    box: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-200',
    icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  readonly: {
    box: 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-200',
    icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  },
  info: {
    box: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-200',
    icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  offline: {
    box: 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-200',
    icon: 'M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414',
  },
};

export default function NoticeBanner({ tone = 'warning', title, children, testId, role = 'status', className = '', onDismiss }) {
  const t = TONES[tone] || TONES.warning;
  return (
    <div
      className={`px-4 py-2 ${t.box} text-sm flex items-center gap-2 ${className}`.trim()}
      role={role}
      data-testid={testId}
      data-tone={tone}
    >
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={t.icon} />
      </svg>
      {title && <span className="font-medium">{title}</span>}
      {children}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid={testId ? `${testId}-dismiss` : undefined}
          className="ml-auto shrink-0 px-1 leading-none text-base opacity-70 hover:opacity-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-current"
        >
          &times;
        </button>
      )}
    </div>
  );
}

export function NoticeBannerAction({ onClick, busy = false, children, testId, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      data-testid={testId}
      className="underline underline-offset-2 hover:no-underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1 focus-visible:ring-offset-transparent disabled:opacity-60 disabled:cursor-wait"
      {...rest}
    >
      {children}
    </button>
  );
}
