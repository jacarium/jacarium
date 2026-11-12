import { forwardRef, useRef } from 'react';
import { usePopupPosition } from '../../../hooks/usePopupPosition.js';

/**
 * DropdownPanel - a dropdown written inline under its button (the AI chat
 * model picker, a task row's priority / project / repeat pickers): an
 * absolutely positioned panel inside a `relative` wrapper that holds the
 * button. It opens under the button, flips above it when the window has
 * no room below, stays off the window's right edge, and when it fits on
 * neither side takes the roomier one with its height capped and scrolls
 * inside - the shared popup placement (src/hooks/usePopupPosition.js),
 * measured once rendered and again on resize / scroll / size changes.
 *
 * Write the look (colours, border, width) in `className`; the placement
 * (top / bottom, left, max-height, overflow) is the panel's own.
 *
 * @param {string} className
 * @param {number} [gap=4]  between the button and the panel
 * @param {number} [cap]  a height the panel never exceeds (a long list that should stay compact)
 * @param {string} [testId]
 */
const DropdownPanel = forwardRef(function DropdownPanel({ className = '', gap = 4, cap, testId, children, ...rest }, ref) {
  const inner = useRef(null);
  const setRefs = (node) => {
    inner.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
  usePopupPosition(inner, { open: true, mode: 'absolute', gap, cap });
  return (
    <div ref={setRefs} data-testid={testId} className={`sc-dropdown-panel absolute top-full left-0 ${className}`} style={{ marginTop: `${gap}px` }} {...rest}>
      {children}
    </div>
  );
});

export default DropdownPanel;
