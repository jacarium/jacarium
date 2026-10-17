import { useEffect, useSyncExternalStore } from 'react';
import { applyMobileAttribute, detectMobile, subscribeMobile } from '../utils/mobile';

const subscribe = (onChange) => subscribeMobile(typeof window !== 'undefined' ? window : undefined, onChange);
const read = () => detectMobile();
const readServer = () => false;

/**
 * True while the app runs in a browser on a phone (src/utils/mobile.js):
 * re-evaluated on resize and rotation. Keeps <html data-mobile> in step so
 * src/mobile.css applies only then.
 */
export function useIsMobile() {
  const mobile = useSyncExternalStore(subscribe, read, readServer);
  useEffect(() => {
    applyMobileAttribute(typeof document !== 'undefined' ? document : null, mobile);
  }, [mobile]);
  return mobile;
}
