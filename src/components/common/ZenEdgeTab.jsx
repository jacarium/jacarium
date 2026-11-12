import { useState } from 'react';

/**
 * A pull-out tab at the middle of a window edge, for zen mode (Settings >
 * Accessibility): a slim handle with a grip mark, low-key at rest, a little
 * wider on hover or focus with a small, quiet chip naming it in one word
 * ("Sidebar", "Navigation"; `chip`), text only, after a short delay (src/index.css). It opens on a click
 * (Enter / Space on the focused tab too), or through the shortcut named in
 * the chip (Settings > Shortcuts > Reading: "Show sidebar / sections",
 * "Show navigation"); hovering only shows the chip - nothing opens or closes by
 * the pointer passing. What it opens closes with Esc, a click outside or a
 * pick inside. The hit area is the tab alone, so nothing under it is
 * blocked. Theme tokens only (src/index.css .sc-zen-tab), so the reading
 * aids, high contrast and the palettes apply. Desktop only: the phone
 * layout has its own drawers and bottom bar.
 *
 * @param {'left'|'right'} side  the window edge
 * @param {string} label        the accessible name ("Show sidebar", "Show navigation")
 * @param {string} chip         the visible one-word chip ("Sidebar", "Navigation")
 * @param {string} hint         the shortcut's chord ("⌥⌘["), '' when unassigned: aria-keyshortcuts and a hidden description
 * @param {boolean} expanded    aria-expanded: whether what it opens is open
 * @param {string} haspopup     aria-haspopup ('dialog' for an overlay)
 * @param {function} onOpen     a click, Enter or Space on the tab
 * @param {React.ReactNode} children  rendered beside the tab by the owner
 */
export default function ZenEdgeTab({ side = 'left', label, chip, hint = '', expanded = false, haspopup = 'dialog', onOpen, testId, controls, children, buttonRef }) {
  const [hover, setHover] = useState(false);
  const descId = `zen-edge-${side}-desc`;
  return (
    <div className={`sc-zen-edge sc-zen-edge-${side}`} data-edge={side}>
      <button
        ref={buttonRef}
        type="button"
        className={`sc-zen-tab ${hover ? 'is-hover' : ''}`}
        aria-label={label}
        aria-keyshortcuts={hint || undefined}
        aria-expanded={expanded}
        aria-haspopup={haspopup}
        aria-controls={controls}
        aria-describedby={hint ? descId : undefined}
        onClick={() => onOpen && onOpen()}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        data-testid={testId}
      >
        <span className="sc-zen-grip" aria-hidden="true" />
        <span className="sc-zen-tab-label" aria-hidden="true" data-testid={testId ? `${testId}-chip` : undefined}>{chip || label}</span>
      </button>
      {hint ? <span id={descId} className="sr-only">Shortcut {hint}</span> : null}
      {children}
    </div>
  );
}
