/* eslint-disable react-refresh/only-export-components */
/**
 * The app's UI primitives: one vocabulary for every page, window and dialog
 * (the Settings dialog, the pages' toolbars, the Kanban and task dialogs,
 * the sign-in pages ...), built on the theme tokens in src/index.css:
 *
 *   radius     --radius-control (buttons, fields), --radius-card, --radius-menu,
 *              --radius-chip (badges), --radius-check (checkboxes); full for pills
 *   weight     --weight-control (buttons, fields, labels: normal), headings 600
 *   colours    the --os-* tokens only (no raw hex, no gray-* in components);
 *              blue is the action colour, red danger, amber warning, green ok
 *   focus      the shared ring (focus-visible:ring-2 ring-os-blue/40)
 *
 * Policy: text buttons carry no icons (the label is the affordance);
 * icon-only controls use <IconButton> with an aria-label; section headings
 * are text. Each primitive carries a stable `sc-*` class the visual audits
 * recognise (tests/settings-visual-audit.test.mjs, tests/ui-primitives.test.mjs).
 */
import { AlertTriangle, Info } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

export const FIELD_CLASS = 'sc-field w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted outline-hidden focus:border-os-blue focus-visible:ring-2 focus-visible:ring-os-blue/40 disabled:opacity-50 transition-colors';
export const FIELD_MONO_CLASS = `${FIELD_CLASS} font-mono`;
/** The same field, compact (toolbars, inline filters). */
export const FIELD_SM_CLASS = FIELD_CLASS.replace('px-3 py-2 text-sm', 'px-2.5 py-1.5 text-xs');

/** Label / control / hint (or error). */
export function Field({ label, hint, error, htmlFor, children, className = '', testId }) {
  return (
    <div className={`sc-field-row ${className}`} data-testid={testId}>
      {label && <label htmlFor={htmlFor} className="sc-label block text-xs text-os-text-primary mb-1.5">{label}</label>}
      {children}
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : hint ? <p className="mt-1 text-xs text-os-text-muted">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ mono = false, size = 'md', className = '', ...props }) {
  const base = size === 'sm' ? FIELD_SM_CLASS : FIELD_CLASS;
  return <input type="text" {...props} className={`${base} ${mono ? 'font-mono' : ''} ${className}`} />;
}
export const Input = TextInput;

export function PasswordInput({ className = '', ...props }) {
  return <input type="password" autoComplete="off" {...props} className={`${FIELD_MONO_CLASS} ${className}`} />;
}

export function NumberInput({ className = '', ...props }) {
  return <input type="number" {...props} className={`${FIELD_CLASS} ${className}`} />;
}

export function SearchInput({ className = '', ...props }) {
  return <input type="search" {...props} className={`${FIELD_CLASS} ${className}`} />;
}

export function Select({ size = 'md', className = '', children, ...props }) {
  return <select {...props} className={`${size === 'sm' ? FIELD_SM_CLASS : FIELD_CLASS} ${className}`}>{children}</select>;
}

export function TextArea({ mono = true, className = '', ...props }) {
  return <textarea rows={3} {...props} className={`${mono ? FIELD_MONO_CLASS : FIELD_CLASS} ${className}`} />;
}

const CHECK_CLASS = 'sc-check mt-0.5 shrink-0 accent-os-blue focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40';

/** A checkbox with its label and hint on the right. */
export function Checkbox({ label, hint, checked, onChange, disabled = false, title, testId, className = '' }) {
  return (
    <label className={`sc-checkbox flex items-start gap-3 ${disabled ? 'opacity-70' : 'cursor-pointer'} ${className}`} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange?.(e.target.checked)} disabled={disabled} data-testid={testId} className={CHECK_CLASS} />
      <span className="min-w-0">
        {label && <span className="block text-xs text-os-text-primary">{label}</span>}
        {hint && <span className="block text-xs text-os-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

/** A radio with its label on the right (name groups them). */
export function Radio({ label, hint, name, value, checked, onChange, disabled = false, testId, className = '' }) {
  return (
    <label className={`sc-radio flex items-start gap-3 ${disabled ? 'opacity-70' : 'cursor-pointer'} ${className}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange?.(value)} disabled={disabled} data-testid={testId} className={CHECK_CLASS} />
      <span className="min-w-0">
        {label && <span className="block text-xs text-os-text-primary">{label}</span>}
        {hint && <span className="block text-xs text-os-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

/** An on/off switch (role="switch"); `label` sits on the right. */
export function Toggle({ checked, onChange, label, hint, disabled = false, testId, className = '' }) {
  return (
    <label className={`sc-toggle flex items-start gap-3 ${disabled ? 'opacity-70' : 'cursor-pointer'} ${className}`}>
      <button type="button" role="switch" aria-checked={!!checked} disabled={disabled} data-testid={testId} onClick={() => onChange?.(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${checked ? 'bg-blue-600 border-blue-600' : 'bg-os-card-secondary border-os-input-border'}`}>
        <span className={`absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
      <span className="min-w-0">
        {label && <span className="block text-xs text-os-text-primary">{label}</span>}
        {hint && <span className="block text-xs text-os-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

const BTN = 'inline-flex items-center justify-center gap-2 rounded-sm transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40';
const BTN_SIZE = { sm: 'px-2.5 py-1 text-xs', md: 'px-3 py-1.5 text-xs', lg: 'px-4 py-2 text-sm' };
export const BUTTON = {
  primary: `sc-btn sc-btn-primary ${BTN} ${BTN_SIZE.md} bg-blue-600 hover:bg-blue-700 text-white`,
  secondary: `sc-btn sc-btn-secondary ${BTN} ${BTN_SIZE.md} bg-os-modal border border-os-input-border text-os-text-primary hover:bg-os-card-secondary`,
  danger: `sc-btn sc-btn-danger ${BTN} ${BTN_SIZE.md} bg-os-modal border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20`,
  dangerSolid: `sc-btn sc-btn-danger-solid ${BTN} ${BTN_SIZE.md} bg-red-600 hover:bg-red-700 text-white`,
  warning: `sc-btn sc-btn-warning ${BTN} ${BTN_SIZE.md} bg-amber-600 hover:bg-amber-700 text-white`,
  success: `sc-btn sc-btn-success ${BTN} ${BTN_SIZE.md} bg-green-600 hover:bg-green-700 text-white`,
  ghost: `sc-btn sc-btn-ghost ${BTN} ${BTN_SIZE.md} text-os-text-secondary hover:bg-os-card-secondary hover:text-os-text-primary`,
  link: `sc-btn sc-btn-link inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 rounded-sm`,
};

/**
 * A text button. Variants: primary (blue), secondary (bordered), danger
 * (red outline), dangerSolid, warning, success, ghost, link. Sizes sm/md/lg.
 * Icons do not belong in text buttons (see the policy above); use
 * <IconButton> for an icon-only control.
 */
export function Button({ variant = 'secondary', size = 'md', children, className = '', type = 'button', ...props }) {
  const base = (BUTTON[variant] || BUTTON.secondary).replace(BTN_SIZE.md, BTN_SIZE[size] || BTN_SIZE.md);
  return <button type={type} {...props} className={`${base} ${className}`}>{children}</button>;
}

/** An icon-only button: `label` becomes the aria-label and the tooltip. */
export function IconButton({ icon: Icon, label, size = 16, variant = 'ghost', className = '', type = 'button', children, ...props }) {
  const tone = variant === 'danger' ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20' : variant === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-700' : 'text-os-text-secondary hover:text-os-text-primary hover:bg-os-card-secondary';
  return (
    <button type={type} aria-label={label} title={label} {...props} className={`sc-icon-btn inline-flex items-center justify-center p-1.5 rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${tone} ${className}`}>
      {Icon ? <Icon size={size} /> : children}
    </button>
  );
}

/** A row of buttons for a dialog footer or a form's end (right-aligned). */
export function ButtonRow({ children, align = 'end', className = '' }) {
  return <div className={`sc-button-row flex flex-wrap items-center gap-2 ${align === 'start' ? 'justify-start' : align === 'between' ? 'justify-between' : 'justify-end'} ${className}`}>{children}</div>;
}

/** Segmented control: one of `options` ({ id, label }) is active. */
export function Segmented({ options, value, onChange, size = 'md', className = '', testId }) {
  return (
    <div className={`sc-segmented inline-flex rounded-sm border border-os-input-border overflow-hidden ${className}`} role="group" data-testid={testId}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)} title={o.title}
          className={`${size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-xs'} transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${value === o.id ? 'bg-blue-600 text-white' : 'bg-os-modal text-os-text-secondary hover:bg-os-card-secondary hover:text-os-text-primary'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

/** Uppercase section heading over a divider (text only). */
export function SectionHeading({ title, actions = null, className = '' }) {
  return (
    <div className={`flex items-center justify-between gap-3 pb-2 border-b border-os-border ${className}`}>
      <h3 className="sc-section-title text-xs font-text font-semibold text-os-text-primary uppercase tracking-wide truncate min-w-0">{title}</h3>
      {actions}
    </div>
  );
}

/** A section: heading over a divider, optional description, then its content. `tone` is kept for callers; the heading stays text. */
export function Section({ title, description, children, testId, actions = null, className = '' }) {
  return (
    <section className={`sc-section space-y-3 ${className}`} data-testid={testId}>
      <SectionHeading title={title} actions={actions} />
      {description && <p className="text-xs text-os-text-muted">{description}</p>}
      {children}
    </section>
  );
}

/** The header of a page or a panel: title, optional subtitle, actions on the right. */
export function PageHeader({ title, subtitle, actions = null, className = '', testId }) {
  return (
    <div className={`sc-page-header flex items-start justify-between gap-3 ${className}`} data-testid={testId}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-os-text-primary truncate">{title}</h2>
        {subtitle && <p className="text-xs text-os-text-secondary mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/** A toolbar strip: controls in a row with the panel's bottom border. */
export function Toolbar({ children, className = '', testId }) {
  return <div className={`sc-toolbar flex flex-wrap items-center gap-2 px-3 py-2 border-b border-os-border bg-os-card ${className}`} data-testid={testId}>{children}</div>;
}

/** A card: the panel surface with a border and the card radius. `padded` adds p-4. */
export function Card({ children, className = '', padded = true, testId, ...props }) {
  return <div className={`sc-card bg-os-card border border-os-border rounded-lg ${padded ? 'p-4' : ''} ${className}`} data-testid={testId} {...props}>{children}</div>;
}
export const Panel = Card;

/** A bordered group of related fields inside a section. */
export function Group({ title, children, className = '' }) {
  return (
    <div className={`sc-group rounded-sm border border-os-border p-3 space-y-3 ${className}`}>
      {title && <p className="text-xs font-semibold text-os-text-primary">{title}</p>}
      {children}
    </div>
  );
}

/** Rows of key/value information (quiet card). */
export function InfoRows({ children, testId }) {
  return <div className="sc-info rounded-sm border border-os-border bg-os-card-secondary divide-y divide-os-border" data-testid={testId}>{children}</div>;
}

export function InfoRow({ children, testId }) {
  return (
    <div className="p-3 flex items-start gap-3" data-testid={testId}>
      <div className="text-xs text-os-text-primary min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A table's container: border, the card radius, horizontal scroll. */
export function TableContainer({ children, className = '', testId }) {
  return <div className={`sc-table rounded-lg border border-os-border overflow-x-auto ${className}`} data-testid={testId}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

/** A quiet note box; `tone` warning/danger/info colours it (the tone's marker icon stays: it is the callout's meaning). */
export function Note({ tone = 'neutral', icon, children, className = '', testId }) {
  const tones = {
    neutral: 'border-os-border bg-os-card-secondary text-os-text-secondary',
    info: 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200',
    warning: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200',
    danger: 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200',
    success: 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200',
  };
  const Icon = icon === undefined ? (tone === 'warning' || tone === 'danger' ? AlertTriangle : tone === 'info' ? Info : null) : icon;
  return (
    <div className={`sc-note rounded-sm border p-3 text-xs flex items-start gap-2 ${tones[tone] || tones.neutral} ${className}`} data-testid={testId} role={tone === 'danger' ? 'alert' : undefined}>
      {Icon && <Icon size={14} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
export const Notice = Note;

/** A one-line status: green when ok, red otherwise. */
export function StatusLine({ status, testId }) {
  if (!status) return null;
  return (
    <p className={`sc-status text-xs ${status.ok ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`} role={status.ok ? 'status' : 'alert'} data-testid={testId}>
      {status.text}
    </p>
  );
}

/** A small label: neutral, blue, green, amber, red, purple; `pill` rounds it fully. */
export function Badge({ tone = 'neutral', pill = false, children, className = '', title }) {
  const tones = {
    neutral: 'bg-os-card-secondary text-os-text-secondary border-os-border',
    blue: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
    green: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
    amber: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
    red: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
    purple: 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800',
  };
  return <span className={`sc-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] leading-4 border ${pill ? 'rounded-full' : 'rounded-xs'} ${tones[tone] || tones.neutral} ${className}`} title={title}>{children}</span>;
}
export const Chip = Badge;

/** The empty state of a list or a page: a large muted icon, a title, a line of help, an optional action. */
export function EmptyState({ icon: Icon, title, description, action = null, compact = false, className = '', testId }) {
  return (
    <div className={`sc-empty flex flex-col items-center justify-center text-center ${compact ? 'py-6 px-3' : 'py-12 px-6'} ${className}`} data-testid={testId}>
      {Icon && <Icon size={compact ? 28 : 48} className="text-os-text-muted mb-3" strokeWidth={1.5} />}
      {title && <p className={`${compact ? 'text-xs' : 'text-base'} font-semibold text-os-text-primary`}>{title}</p>}
      {description && <p className={`${compact ? 'text-[11px]' : 'text-xs'} text-os-text-secondary mt-1 max-w-sm`}>{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Navigation inside a view                                            */
/* ------------------------------------------------------------------ */

/** Underlined sub-tabs. */
export function SubTabs({ tabs, active, onChange, className = '' }) {
  return (
    <div className={`sc-subtabs border-b border-os-border -mt-1 mb-4 ${className}`}>
      <div className="flex flex-wrap gap-1" role="tablist">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={active === tab.id} onClick={() => onChange(tab.id)}
            className={`px-3 py-1.5 text-xs transition-colors whitespace-nowrap border-b-2 -mb-px rounded-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${active === tab.id ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-os-text-secondary hover:text-os-text-primary'}`}>
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
export const Tabs = SubTabs;

/* ------------------------------------------------------------------ */
/* Dialog chrome (used with BaseModal)                                 */
/* ------------------------------------------------------------------ */

/** A dialog's header: title (text) and the close control on the right. */
export function ModalHeader({ title, subtitle, onClose, actions = null, className = '', closeLabel = 'Close' }) {
  return (
    <div className={`sc-modal-header p-4 border-b border-os-border bg-os-modal flex items-center justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide truncate">{title}</h2>
        {subtitle && <p className="text-xs text-os-text-secondary mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {onClose && <CloseButton onClick={onClose} label={closeLabel} />}
      </div>
    </div>
  );
}

/** A dialog's footer: an optional note on the left, the buttons on the right. */
export function ModalFooter({ note = null, children, className = '' }) {
  return (
    <div className={`sc-modal-footer p-4 border-t border-os-border bg-os-modal flex flex-wrap items-center ${note ? 'justify-between' : 'justify-end'} gap-3 ${className}`}>
      {note && <p className="text-xs text-os-text-muted min-w-0">{note}</p>}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/** The × of a dialog or a panel. */
export function CloseButton({ onClick, label = 'Close', className = '' }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={`sc-icon-btn p-1 rounded-sm text-os-text-secondary hover:text-os-text-primary hover:bg-os-card-secondary transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${className}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** A link that opens outside the app (the desktop's default browser, a new tab otherwise). */
export function ExternalLink({ href, children, className = '' }) {
  const open = () => { if (window.electronAPI?.openExternal) window.electronAPI.openExternal(href); else window.open(href, '_blank', 'noopener'); };
  return <button type="button" onClick={open} className={`${BUTTON.link} ${className}`}>{children}</button>;
}

export function Code({ children, className = '' }) {
  return <code className={`bg-os-card-secondary px-1 py-0.5 rounded-xs font-mono ${className}`}>{children}</code>;
}
