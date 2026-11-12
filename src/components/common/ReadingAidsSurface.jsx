/* eslint-disable react-refresh/only-export-components -- the hooks belong with the surface they feed */
import { useEffect, useState } from 'react';
import {
  READING_AIDS_CHANGED_EVENT, ZEN_CHANGED_EVENT, applyAppReadingAids, loadReadingAids, readingAidsClasses, readingAidsVars, systemReducesMotion, zenMode, ZEN_PANEL_CHANGED_EVENT, zenPanel } from '../../utils/readingAids';
import { ensureReadingFont } from '../../utils/readingFonts';

/**
 * The reading aids' mechanism (src/utils/readingAids.js) on the React side:
 *  - `useAppReadingAids()` (the shell) keeps <html> carrying the app-wide
 *    options as classes and `--ra-*` properties, and loads the chosen font;
 *  - `ReadingAidsSurface` is the element for the documents-only options -
 *    the Documents page wraps its editor / preview pane in one; the
 *    Accessibility settings' sample is another.
 */

/** The current reading aids, following Settings > Accessibility live (the change event). */
export function useReadingAids() {
  const [settings, setSettings] = useState(() => loadReadingAids());
  useEffect(() => {
    const onChange = (e) => setSettings(e.detail ? e.detail : loadReadingAids());
    window.addEventListener(READING_AIDS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(READING_AIDS_CHANGED_EVENT, onChange);
  }, []);
  return settings;
}

/** The OS's prefers-reduced-motion answer, live (Reduce motion: Follow system). */
export function useSystemReducedMotion() {
  const [reduced, setReduced] = useState(() => systemReducesMotion());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    let mq; try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return undefined; }
    const onChange = () => setReduced(!!mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** The app-wide options on <html>, live; the chosen reading font's faces load the first time it is chosen. Returns the settings. */
export function useAppReadingAids() {
  const settings = useReadingAids();
  const systemMotion = useSystemReducedMotion();
  useEffect(() => { applyAppReadingAids(settings); }, [settings, systemMotion]);   // Follow system: the OS query's answer is part of the classes
  useEffect(() => { ensureReadingFont(settings.font).catch(() => {}); }, [settings.font]);
  useEffect(() => { ensureReadingFont(settings.codeFont).catch(() => {}); }, [settings.codeFont]);   // the code font, the same way
  return settings;
}

/** Whether zen mode is on, live. */
export function useZenMode() {
  const [on, setOn] = useState(() => zenMode.on);
  useEffect(() => {
    const onChange = (e) => setOn(!!(e.detail ? e.detail.on : zenMode.on));
    window.addEventListener(ZEN_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ZEN_CHANGED_EVENT, onChange);
  }, []);
  return on;
}

/** The panel shown as the zen overlay (zenPanel), live: its id or null. */
export function useZenPanel() {
  const [id, setId] = useState(() => zenPanel.id);
  useEffect(() => {
    const onChange = (e) => setId(e.detail ? e.detail.id : zenPanel.id);
    window.addEventListener(ZEN_PANEL_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ZEN_PANEL_CHANGED_EVENT, onChange);
  }, []);
  return id;
}

export default function ReadingAidsSurface({ children, className = '', settings = null, style = null, testId, ...props }) {
  const live = useReadingAids();
  const s = settings || live;
  return (
    <div {...props} className={`${readingAidsClasses(s, 'documents').join(' ')} ${className}`} style={{ ...readingAidsVars(s, 'documents'), ...(style || {}) }} data-reading-aids="" data-testid={testId}>
      {children}
    </div>
  );
}
