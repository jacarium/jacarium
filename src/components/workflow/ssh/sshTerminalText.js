/**
 * Pure text helpers of the interactive SSH terminal: cleaning shell output,
 * the {{VAR}} placeholders of saved commands, and turning the raw echo of a
 * double-TAB into a list of completions.
 */

// Strip ANSI escape/control sequences from terminal output.
// Matching control characters is the whole point here, so the rule that
// guards against accidental control chars in regexes is disabled for this
// helper only.
/* eslint-disable no-control-regex */
export function stripAnsi(text) {
  if (!text) return '';
  return text
    // ANSI escape codes
    .replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[^\x1b]*?[mGKHfABCDsuJSTL]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*?\x1b\\/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b/g, '')
    // Control characters (including backspace U+0008)
    .replace(/[\x00-\x08]/g, '') // NULL to backspace
    .replace(/[\x0B-\x0C]/g, '') // Vertical tab, form feed
    .replace(/[\x0E-\x1F]/g, '') // Other control chars (except \t \n \r)
    .replace(/\x7F/g, '') // DEL
    .replace(/\x07/g, '') // Bell
    .replace(/\r/g, ''); // Carriage return
}
/* eslint-enable no-control-regex */

/** The distinct {{VAR_NAME}} placeholders of a saved command, in order. */
export function extractVariables(command) {
  const regex = /\{\{([^}]+)\}\}/g;
  const variables = [];
  let match;
  while ((match = regex.exec(command)) !== null) {
    if (!variables.includes(match[1])) {
      variables.push(match[1]);
    }
  }
  return variables;
}

/** Fill the {{VAR_NAME}} placeholders of `command` from `values`. */
export function replaceVariables(command, values) {
  let result = command;
  Object.entries(values).forEach(([key, value]) => {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  });
  return result;
}

/**
 * Extract completion candidates from what the shell echoed after
 * `originalInput` + TAB TAB. Bash either echoes the input with the
 * completion appended ("cd 001<tabs>cd 0010-dir/") or lists the options
 * ("0010-dir/ other-dir/"), possibly followed by a fresh prompt. Candidates
 * are the words that are not part of the input and that extend the word
 * being completed (any word when the input ends in a space).
 */
export function parseCompletionOutput(buffer, originalInput) {
  const lines = stripAnsi(buffer).split('\n').map(line => line.trim()).filter(l => l);

  // Input ending in whitespace means a new (empty) word is being completed,
  // otherwise the last word is
  const endsWithSpace = originalInput !== originalInput.trimEnd();
  const inputWords = originalInput.split(/\s+/).filter(w => w);
  const lastInputWord = endsWithSpace ? '' : (inputWords[inputWords.length - 1] || '');
  const inputTrimmed = originalInput.trimEnd();

  const completionOptions = new Set();

  for (const line of lines) {
    // Skip lines that look like prompts (end with $ or # or contain username@host)
    if (line.match(/[$#]\s*$/) || line.includes('@')) continue;

    // If the line starts with our input, the completions come after it;
    // otherwise the whole line is potential completions
    const completionPart = (line.startsWith(inputTrimmed) ? line.substring(inputTrimmed.length) : line).trim();
    if (!completionPart) continue;

    const words = completionPart.split(/\s+/).filter(w => w && !w.includes('$') && !w.includes('#') && !w.includes('@'));

    for (const word of words) {
      // Skip words that are part of our input (e.g., "cd")
      if (inputWords.includes(word)) continue;

      // Skip words ending in a command (e.g., ".../cd" - malformed due to concatenation)
      if (/\/(cd|ls|pwd|cat|echo|grep|find)$/.test(word)) continue;

      // Skip a partial echo of the word being completed
      if (lastInputWord && word.startsWith(lastInputWord) && word.length <= lastInputWord.length) continue;

      // Keep words that extend the word being completed (any word for a new word)
      if (!lastInputWord || word.startsWith(lastInputWord)) {
        completionOptions.add(word);
      }
    }
  }

  return Array.from(completionOptions);
}

/**
 * `input` with its last word replaced by `completion` (after a trailing
 * space the "last word" is empty, so the completion is appended). The
 * replacement happens whether or not the completion extends the word: the
 * user picked it from the list.
 */
export function applyCompletion(input, completion) {
  const words = input.split(/\s+/);
  words[words.length - 1] = completion;
  return words.join(' ');
}
