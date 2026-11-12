import { useEffect, useState } from 'react';
import { useZenMode } from './ReadingAidsSurface';
import { zenMode } from '../../utils/readingAids';
import { useShortcutLabel } from '../../shortcuts/useShortcut';

/**
 * The "Zen" label in the bottom-right status corner while zen mode is on,
 * beside the connection indicator (StatusCorner): a quiet, small button
 * that leaves zen on click or Enter. Its tooltip / name carries what the
 * old footer bar said, with the chords read from the shortcut registry
 * (a rebinding shows): "Zen mode: Esc or ⇧⌘E to leave · ⌥⌘[ sidebar · ⌥⌘]
 * navigation". Entering zen is announced once through a polite live region
 * (visually hidden), so a screen-reader user still learns how to leave.
 * Nothing shows outside zen.
 */
export default function ZenBadge() {
  const zen = useZenMode();
  const leave = useShortcutLabel('reading.zen');
  const sidebar = useShortcutLabel('reading.showSidebar');
  const goTo = useShortcutLabel('reading.showPanels');
  const title = `Zen mode: Esc${leave ? ` or ${leave}` : ''} to leave${sidebar ? ` · ${sidebar} sidebar` : ''}${goTo ? ` · ${goTo} navigation` : ''}`;
  // the announcement: set when zen comes on, cleared when it goes (a status region reads its changes, once)
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    // set after the current task (a status region reads a change, not the initial text); cleared the same way when zen goes
    const t = setTimeout(() => setAnnounce(zen ? title : ''), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the chords may change while zen is on; the announcement is the entering one
  }, [zen]);
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only" data-testid="zen-announce">{announce}</span>
      {zen && (
        <button
          type="button"
          onClick={() => zenMode.set(false)}
          title={title}
          aria-label={title}
          data-testid="zen-badge"
          className="pointer-events-auto select-none flex items-center px-1.5 py-1 rounded-sm text-xs bg-os-card border border-os-border shadow-xs text-os-text-secondary hover:text-os-text-primary hover:bg-os-card-secondary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40"
        >
          Zen
        </button>
      )}
    </>
  );
}
