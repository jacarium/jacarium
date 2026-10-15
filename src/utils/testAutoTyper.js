/**
 * Auto-typer for testing collaborative editing
 * Simulates a user typing text character by character
 */

let typingInterval = null;
let currentIndex = 0;

const testTexts = [
  "The quick brown fox jumps over the lazy dog. ",
  "Testing collaborative editing with Yjs. ",
  "This is line one.\nThis is line two.\nThis is line three. ",
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ",
  "Another test sentence for concurrent editing. ",
];

/**
 * Start auto-typing into a textarea
 * @param {HTMLTextAreaElement} textarea - The textarea to type into
 * @param {Function} onChange - The onChange handler to call after each character
 * @param {number} speed - Milliseconds between characters (default: 200)
 */
export function startAutoTyping(textarea, onChange, speed = 200) {
  if (typingInterval) {
    stopAutoTyping();
  }

  const textToType = testTexts[Math.floor(Math.random() * testTexts.length)];
  currentIndex = 0;

  console.log('[AutoTyper] Starting auto-typing:', textToType.substring(0, 50));

  typingInterval = setInterval(() => {
    if (currentIndex >= textToType.length) {
      console.log('[AutoTyper] Finished typing');
      stopAutoTyping();
      return;
    }

    // Always insert at the END of the document to avoid conflicts
    const char = textToType[currentIndex];
    const newValue = textarea.value + char;

    // Update textarea value
    textarea.value = newValue;

    // Move cursor to end
    const newCursorPos = newValue.length;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;

    // Trigger onChange event
    const event = new Event('input', { bubbles: true });
    Object.defineProperty(event, 'target', { value: textarea, enumerable: true });
    onChange(event);

    currentIndex++;
  }, speed);
}

/**
 * Stop auto-typing
 */
export function stopAutoTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
    currentIndex = 0;
    console.log('[AutoTyper] Stopped');
  }
}

/**
 * Check if auto-typing is active
 */
export function isAutoTyping() {
  return typingInterval !== null;
}
