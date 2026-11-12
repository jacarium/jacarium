import { useState, useCallback, useEffect, useRef } from 'react';
import { usePopupPosition } from './usePopupPosition.js';

/**
 * Custom hook for managing context menu state and behavior
 * @returns {object} Context menu state and functions
 */
export function useContextMenu() {
  const [contextMenu, setContextMenu] = useState({
    visible: false,
    x: 0,
    y: 0,
    type: null,
    target: null,
  });

  const contextMenuRef = useRef(null);

  // Inside the window, whatever the menu's markup: the pages that draw their own menu div (ref={contextMenuRef},
  // left / top from x / y) get the shared placement here - below / right of the pointer when it fits, flipped above /
  // left when not, clamped and scrolling inside otherwise, re-measured as it renders and resizes. A menu drawn with
  // <ContextMenu> places itself the same way (the same answer, written twice at most).
  usePopupPosition(contextMenuRef, { open: contextMenu.visible, anchor: () => ({ left: contextMenu.x, top: contextMenu.y }), deps: [contextMenu.x, contextMenu.y] });

  /**
   * Open context menu at cursor position
   * @param {Event} e - Mouse event
   * @param {string} type - Type of context menu (e.g., 'document', 'category', 'template')
   * @param {*} target - Target data (e.g., document object, category name)
   */
  const openContextMenu = useCallback((e, type, target) => {
    e.preventDefault();
    e.stopPropagation();

    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      type,
      target,
    });
  }, []);

  // The menu stays inside the window on its own: ContextMenu places itself from x / y with the shared popup
  // placement (src/hooks/usePopupPosition.js - flip, clamp, scroll inside), re-measured as it renders and resizes.

  /**
   * Close context menu
   */
  const closeContextMenu = useCallback(() => {
    setContextMenu({
      visible: false,
      x: 0,
      y: 0,
      type: null,
      target: null,
    });
  }, []);

  /**
   * Handle context menu item click
   * @param {Function} action - Action to execute
   */
  const handleContextMenuAction = useCallback((action) => {
    if (action) {
      action(contextMenu.target);
    }
    closeContextMenu();
  }, [contextMenu.target, closeContextMenu]);

  /**
   * Check if context menu is of specific type
   */
  const isContextMenuType = useCallback((type) => {
    return contextMenu.visible && contextMenu.type === type;
  }, [contextMenu.visible, contextMenu.type]);

  // Close context menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target)) {
        closeContextMenu();
      }
    }

    if (contextMenu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu.visible, closeContextMenu]);

  // Close context menu on Escape key
  useEffect(() => {
    function handleEscape(event) {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    }

    if (contextMenu.visible) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [contextMenu.visible, closeContextMenu]);

  return {
    contextMenu,
    contextMenuRef,
    openContextMenu,
    closeContextMenu,
    handleContextMenuAction,
    isContextMenuType,
    setContextMenu, // For advanced use cases
  };
}

/**
 * Hook for managing dropdown menu state (hamburger menus, etc.)
 * @returns {object} Menu state and functions
 */
export function useDropdownMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0, left: undefined });
  const menuRef = useRef(null);

  /**
   * Open dropdown menu at button position
   * @param {Event} e - Click event from button
   * @param {object} options - Positioning options
   * @param {string} [options.align='right'] - Horizontal alignment ('left' or 'right')
   * @param {number} [options.offset=4] - Gap between button and menu in px
   * @param {number} [options.menuWidth=180] - Estimated menu width in px, used for viewport clamping
   * @param {number} [options.menuHeight=280] - Estimated menu height in px, used for viewport clamping
   */
  const openMenu = useCallback((e, options = {}) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const {
      align = 'right',
      offset = 4,
      menuWidth = 180, // min-w-[180px] typical menu width
      menuHeight = 280 // estimated menu height (conservative for larger menus)
    } = options;

    let top;

    // Check if menu would overflow bottom edge
    if (rect.bottom + offset + menuHeight > window.innerHeight) {
      // Position above the button
      top = rect.top - menuHeight - offset;
    } else {
      // Position below the button
      top = rect.bottom + offset;
    }

    const pos = {
      top,
      // the button's rectangle and the alignment: HamburgerMenu (and the pickers) place themselves from these with the
      // shared popup placement, measured once rendered; top / left / right below are the first guess from the estimates
      anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      align,
      offset,
    };

    if (align === 'right') {
      let right = window.innerWidth - rect.right;

      // Adjust if would overflow left edge (when positioning from right)
      const leftPosition = window.innerWidth - right - menuWidth;
      if (leftPosition < 10) {
        right = window.innerWidth - menuWidth - 10;
      }

      pos.right = right;
    } else if (align === 'left') {
      let left = rect.left;

      // Adjust if would overflow right edge
      if (left + menuWidth > window.innerWidth) {
        left = window.innerWidth - menuWidth - 10;
      }

      pos.left = left;
    }

    setPosition(pos);
    setIsOpen(true);
  }, []);

  /**
   * Close dropdown menu
   */
  const closeMenu = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Toggle dropdown menu
   */
  const toggleMenu = useCallback((e, options) => {
    if (isOpen) {
      closeMenu();
    } else {
      openMenu(e, options);
    }
  }, [isOpen, openMenu, closeMenu]);

  /**
   * Handle menu item click
   * @param {Function} action - Action to execute
   */
  const handleMenuAction = useCallback((action) => {
    if (action) {
      action();
    }
    closeMenu();
  }, [closeMenu]);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        closeMenu();
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, closeMenu]);

  // Close menu on Escape key
  useEffect(() => {
    function handleEscape(event) {
      if (event.key === 'Escape') {
        closeMenu();
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, closeMenu]);

  return {
    isOpen,
    position,
    menuRef,
    openMenu,
    closeMenu,
    toggleMenu,
    handleMenuAction,
    setIsOpen, // For advanced use cases
  };
}

/**
 * Hook for managing position-based menus (text selection menu, etc.)
 * @returns {object} Menu state and functions
 */
export function usePositionMenu() {
  const [menu, setMenu] = useState({
    visible: false,
    x: 0,
    y: 0,
    data: null,
  });
  const menuRef = useRef(null);

  const openMenu = useCallback((x, y, data = null) => {
    setMenu({ visible: true, x, y, data });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu({ visible: false, x: 0, y: 0, data: null });
  }, []);

  const handleMenuAction = useCallback((action) => {
    if (action) {
      action(menu.data);
    }
    closeMenu();
  }, [menu.data, closeMenu]);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        closeMenu();
      }
    }

    if (menu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [menu.visible, closeMenu]);

  // Close menu on Escape
  useEffect(() => {
    function handleEscape(event) {
      if (event.key === 'Escape') {
        closeMenu();
      }
    }

    if (menu.visible) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [menu.visible, closeMenu]);

  return {
    menu,
    menuRef,
    openMenu,
    closeMenu,
    handleMenuAction,
  };
}
