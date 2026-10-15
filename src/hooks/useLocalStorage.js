import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Custom hook for managing localStorage with automatic JSON serialization
 * @param {string} key - The localStorage key
 * @param {*} initialValue - Default value if key doesn't exist
 * @param {number} writeDebounceMs - Optional. When > 0, the synchronous
 *   JSON.stringify + localStorage.setItem is deferred until this many ms after the
 *   last update. The React state update itself is ALWAYS synchronous (controlled
 *   inputs stay correct); only the persistence is debounced. Pending writes are
 *   flushed on unmount and on beforeunload so the last update is never lost.
 *   Defaults to 0 (immediate write — the original behavior).
 * @returns {[value, setValue, removeValue]} Tuple of [value, setter, remover]
 */
export function useLocalStorage(key, initialValue, writeDebounceMs = 0) {
  // State to store our value
  // Pass initial state function to useState so logic is only executed once
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  const writeTimerRef = useRef(null);
  const pendingWriteRef = useRef(null); // { value } while a debounced write is pending

  const flushPendingWrite = useCallback(() => {
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    if (pendingWriteRef.current) {
      try {
        window.localStorage.setItem(key, JSON.stringify(pendingWriteRef.current.value));
      } catch (error) {
        console.error(`Error setting localStorage key "${key}":`, error);
      }
      pendingWriteRef.current = null;
    }
  }, [key]);

  // Flush any pending debounced write on unmount and before the window closes
  useEffect(() => {
    if (writeDebounceMs <= 0) return;
    window.addEventListener('beforeunload', flushPendingWrite);
    return () => {
      window.removeEventListener('beforeunload', flushPendingWrite);
      flushPendingWrite();
    };
  }, [writeDebounceMs, flushPendingWrite]);

  // Return a wrapped version of useState's setter function that persists to localStorage
  const setValue = useCallback((value) => {
    try {
      setStoredValue(prevValue => {
        // Allow value to be a function so we have same API as useState
        const valueToStore = value instanceof Function ? value(prevValue) : value;

        if (writeDebounceMs > 0) {
          // Defer only the localStorage write; the React state update stays synchronous
          pendingWriteRef.current = { value: valueToStore };
          if (writeTimerRef.current) {
            clearTimeout(writeTimerRef.current);
          }
          writeTimerRef.current = setTimeout(() => {
            writeTimerRef.current = null;
            if (pendingWriteRef.current) {
              try {
                window.localStorage.setItem(key, JSON.stringify(pendingWriteRef.current.value));
              } catch (error) {
                console.error(`Error setting localStorage key "${key}":`, error);
              }
              pendingWriteRef.current = null;
            }
          }, writeDebounceMs);
        } else {
          // Save to local storage immediately (original behavior)
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
        }

        return valueToStore;
      });
    } catch (error) {
      console.error(`Error setting localStorage key "${key}":`, error);
    }
  }, [key, writeDebounceMs]);

  // Function to remove the key from localStorage
  const removeValue = useCallback(() => {
    try {
      // Cancel any pending debounced write so it can't resurrect the removed key
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      pendingWriteRef.current = null;
      window.localStorage.removeItem(key);
      setStoredValue(initialValue);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, initialValue]);

  return [storedValue, setValue, removeValue];
}

/**
 * Custom hook for managing sessionStorage with automatic JSON serialization (like useState)
 * @param {string} key - The sessionStorage key
 * @param {*} initialValue - Default value if key doesn't exist
 * @returns {[value, setValue]} Tuple of [value, setter]
 */
export function useSessionPersistence(key, initialValue) {
  // State to store our value. A falsy key degrades to plain useState
  // behavior (no persistence), so callers can pass an optional key
  // without calling hooks conditionally.
  const [storedValue, setStoredValue] = useState(() => {
    if (!key) return initialValue;
    try {
      const item = window.sessionStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading sessionStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // Return a wrapped version of useState's setter function that persists to sessionStorage
  const setValue = useCallback((value) => {
    try {
      setStoredValue(prevValue => {
        // Allow value to be a function so we have same API as useState
        const valueToStore = value instanceof Function ? value(prevValue) : value;

        // Save to session storage
        if (key) {
          window.sessionStorage.setItem(key, JSON.stringify(valueToStore));
        }

        return valueToStore;
      });
    } catch (error) {
      console.error(`Error setting sessionStorage key "${key}":`, error);
    }
  }, [key]);

  return [storedValue, setValue];
}

/**
 * Restore session data from localStorage
 * @param {string} sessionKey - The localStorage key for the session
 * @returns {object|null} Restored session data or null
 */
export function restoreSession(sessionKey) {
  try {
    const saved = localStorage.getItem(sessionKey);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (error) {
    console.error(`Failed to restore session "${sessionKey}":`, error);
  }
  return null;
}

/**
 * Clear session data from localStorage
 * @param {string} sessionKey - The localStorage key to clear
 */
export function clearSession(sessionKey) {
  try {
    localStorage.removeItem(sessionKey);
  } catch (error) {
    console.error(`Failed to clear session "${sessionKey}":`, error);
  }
}

/**
 * Hook for managing per-item settings (like documentThemes, documentFontSizes)
 * @param {string} storageKey - The localStorage key
 * @param {*} defaultValue - Default value for new items
 * @returns {[settings, getSetting, setSetting, removeSetting]} Settings management functions
 */
export function useItemSettings(storageKey, defaultValue = {}) {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : {};
    } catch (error) {
      console.error(`Error loading ${storageKey}:`, error);
      return {};
    }
  });

  const getSetting = useCallback((itemId) => {
    return settings[itemId] ?? defaultValue;
  }, [settings, defaultValue]);

  const setSetting = useCallback((itemId, value) => {
    setSettings(prev => {
      const updated = { ...prev, [itemId]: value };
      try {
        localStorage.setItem(storageKey, JSON.stringify(updated));
      } catch (error) {
        console.error(`Error saving ${storageKey}:`, error);
      }
      return updated;
    });
  }, [storageKey]);

  const removeSetting = useCallback((itemId) => {
    setSettings(prev => {
      const updated = { ...prev };
      delete updated[itemId];
      try {
        localStorage.setItem(storageKey, JSON.stringify(updated));
      } catch (error) {
        console.error(`Error saving ${storageKey}:`, error);
      }
      return updated;
    });
  }, [storageKey]);

  return [settings, getSetting, setSetting, removeSetting];
}
