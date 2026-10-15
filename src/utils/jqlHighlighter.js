/**
 * JQL Syntax Highlighter
 * Highlights JQL keywords and operators for better readability
 */

const JQL_KEYWORDS = [
  'AND', 'OR', 'NOT', 'IN', 'NOT IN', 'IS', 'IS NOT',
  'WAS', 'WAS IN', 'WAS NOT', 'WAS NOT IN',
  'CHANGED', 'ORDER BY', 'ASC', 'DESC',
  'EMPTY', 'NULL',
];

const JQL_OPERATORS = ['=', '!=', '>', '<', '>=', '<=', '~', '!~'];

const JQL_FUNCTIONS = [
  'currentUser()', 'startOfDay()', 'endOfDay()', 'startOfWeek()', 'endOfWeek()',
  'startOfMonth()', 'endOfMonth()', 'startOfYear()', 'endOfYear()',
  'now()', 'currentLogin()',
];

/**
 * Highlight JQL syntax with HTML spans
 * @param {string} jql - Raw JQL string
 * @returns {string} - HTML with syntax highlighting
 */
export function highlightJQL(jql) {
  if (!jql) return '';

  let highlighted = jql;

  // Highlight keywords (AND, OR, IN, etc.)
  JQL_KEYWORDS.forEach(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    highlighted = highlighted.replace(
      regex,
      `<span class="jql-keyword">${keyword}</span>`
    );
  });

  // Highlight functions
  JQL_FUNCTIONS.forEach(func => {
    const regex = new RegExp(func.replace('(', '\\(').replace(')', '\\)'), 'gi');
    highlighted = highlighted.replace(
      regex,
      `<span class="jql-function">${func}</span>`
    );
  });

  // Highlight strings in quotes
  highlighted = highlighted.replace(
    /"([^"]*)"/g,
    '<span class="jql-string">"$1"</span>'
  );

  // Highlight field names (words before operators)
  highlighted = highlighted.replace(
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|!=|>|<|>=|<=|~|!~)/g,
    '<span class="jql-field">$1</span> $2'
  );

  return highlighted;
}

/**
 * Highlight JQL for React components (returns JSX-compatible structure)
 * @param {string} jql - Raw JQL string
 * @returns {Array} - Array of JSX elements
 */
export function highlightJQLForReact(jql) {
  if (!jql) return [];

  const parts = [];
  let currentIndex = 0;

  // Create a list of all matches with their positions
  const matches = [];

  // Match keywords
  JQL_KEYWORDS.forEach(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    let match;
    while ((match = regex.exec(jql)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        type: 'keyword',
      });
    }
  });

  // Match strings
  const stringRegex = /"([^"]*)"/g;
  let stringMatch;
  while ((stringMatch = stringRegex.exec(jql)) !== null) {
    matches.push({
      start: stringMatch.index,
      end: stringMatch.index + stringMatch[0].length,
      text: stringMatch[0],
      type: 'string',
    });
  }

  // Match functions
  JQL_FUNCTIONS.forEach(func => {
    const escaped = func.replace('(', '\\(').replace(')', '\\)');
    const regex = new RegExp(escaped, 'gi');
    let match;
    while ((match = regex.exec(jql)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        type: 'function',
      });
    }
  });

  // Match placeholders A, B, C, etc. (single uppercase letters at word boundaries)
  // We need to filter out matches that overlap with keywords
  const placeholderRegex = /\b([A-Z])\b/g;
  let placeholderMatch;
  while ((placeholderMatch = placeholderRegex.exec(jql)) !== null) {
    // Check if this position is already covered by a keyword match
    const isOverlapping = matches.some(m =>
      placeholderMatch.index >= m.start && placeholderMatch.index < m.end
    );

    if (!isOverlapping) {
      matches.push({
        start: placeholderMatch.index,
        end: placeholderMatch.index + placeholderMatch[0].length,
        text: placeholderMatch[0],
        type: 'placeholder',
      });
    }
  }

  // Sort matches by position
  matches.sort((a, b) => a.start - b.start);

  // Build the parts array
  matches.forEach((match, idx) => {
    // Add text before this match
    if (currentIndex < match.start) {
      parts.push({
        text: jql.substring(currentIndex, match.start),
        type: 'text',
        key: `text-${idx}`,
      });
    }

    // Add the match
    parts.push({
      text: match.text,
      type: match.type,
      key: `${match.type}-${idx}`,
    });

    currentIndex = match.end;
  });

  // Add remaining text
  if (currentIndex < jql.length) {
    parts.push({
      text: jql.substring(currentIndex),
      type: 'text',
      key: 'text-end',
    });
  }

  return parts;
}
