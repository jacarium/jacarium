/**
 * Answer matching utilities for quiz answers
 * Handles fuzzy matching with various normalization strategies
 */

// Number word mappings
const NUMBER_WORDS = {
  'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
  'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
  'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
  'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
  'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
  'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
  'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000'
};

/**
 * Normalize answer: lowercase, replace separators with spaces, collapse spaces
 */
function normalize(str) {
  return str.toLowerCase()
    .replace(/[-_]/g, ' ')  // Replace dashes and underscores with spaces
    .replace(/\s+/g, ' ')   // Collapse multiple spaces
    .trim();
}

/**
 * Compact normalize: remove ALL spaces, hyphens, and underscores
 * Handles cases like "Multi-Queue" vs "Multiqueue" or "RAID 10" vs "RAID10"
 */
function normalizeCompact(str) {
  return str.toLowerCase()
    .replace(/[-_\s]/g, '');  // Remove all hyphens, underscores, and spaces
}

/**
 * Convert number words to digits (e.g., "three" -> "3")
 */
function convertNumberWords(str) {
  let result = str.toLowerCase();
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }
  return result;
}

/**
 * Check if answer matches a numeric range (e.g., "10 to 25", "10-25")
 */
function matchesRange(userAnswer, correctAnswer) {
  const rangePattern = /^(?:between\s+)?(\d+)(?:\s*(?:to|-|\.\.)\s*|\s+and\s+)(\d+)$/i;
  const rangeMatch = correctAnswer.match(rangePattern);

  if (!rangeMatch) return false;

  const minValue = parseInt(rangeMatch[1]);
  const maxValue = parseInt(rangeMatch[2]);
  const userNumber = parseFloat(userAnswer.replace(/[^\d.]/g, ''));

  // Check if user answered with a number within the range
  if (!isNaN(userNumber) && userNumber >= minValue && userNumber <= maxValue) {
    return true;
  }

  // Also accept if user gave the full range in any format
  const userRangeMatch = userAnswer.match(rangePattern);
  if (userRangeMatch) {
    const userMin = parseInt(userRangeMatch[1]);
    const userMax = parseInt(userRangeMatch[2]);
    if (userMin === minValue && userMax === maxValue) {
      return true;
    }
  }

  return false;
}

/**
 * Check if answer matches any alternative in "or" separated options
 * (e.g., "same or identical")
 */
function matchesAlternatives(userAnswer, correctAnswer) {
  if (!correctAnswer.includes(' or ')) return false;

  const alternatives = correctAnswer.split(' or ').map(alt => alt.trim());
  const normalizedUser = normalize(userAnswer);
  const compactUser = normalizeCompact(userAnswer);

  // Check if user answer matches any alternative (exact or compact match only)
  for (const alt of alternatives) {
    const compactAlt = normalizeCompact(alt);
    if (normalizedUser === alt || compactUser === compactAlt) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize units to handle abbreviations
 */
function normalizeUnit(unit) {
  if (!unit) return '';
  const u = unit.toLowerCase();

  // Time units
  if (u === 'seconds' || u === 'second' || u === 'sec' || u === 's') return 's';
  if (u === 'milliseconds' || u === 'millisecond' || u === 'msec' || u === 'ms') return 'ms';
  if (u === 'minutes' || u === 'minute' || u === 'min' || u === 'm') return 'm';
  if (u === 'hours' || u === 'hour' || u === 'hr' || u === 'h') return 'h';

  // Data size units
  if (u === 'bytes' || u === 'byte' || u === 'b') return 'b';
  if (u === 'kilobytes' || u === 'kilobyte' || u === 'kb') return 'kb';
  if (u === 'megabytes' || u === 'megabyte' || u === 'mb') return 'mb';
  if (u === 'gigabytes' || u === 'gigabyte' || u === 'gb') return 'gb';
  if (u === 'terabytes' || u === 'terabyte' || u === 'tb') return 'tb';

  // Memory units (uppercase versions)
  if (u === 'kib') return 'kib';
  if (u === 'mib') return 'mib';
  if (u === 'gib') return 'gib';
  if (u === 'tib') return 'tib';

  // Frequency units
  if (u === 'hertz' || u === 'hz') return 'hz';
  if (u === 'kilohertz' || u === 'khz') return 'khz';
  if (u === 'megahertz' || u === 'mhz') return 'mhz';
  if (u === 'gigahertz' || u === 'ghz') return 'ghz';

  // Return as-is if not recognized
  return u;
}

/**
 * Check if numeric answers with units match (e.g., "30 seconds" vs "30s")
 */
function matchesNumericWithUnits(userAnswer, correctAnswer) {
  const numericPattern = /^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i;
  const userMatch = userAnswer.match(numericPattern);
  const correctMatch = correctAnswer.match(numericPattern);

  if (!userMatch || !correctMatch) return false;

  const userNumber = userMatch[1];
  const userUnit = userMatch[2] || '';
  const correctNumber = correctMatch[1];
  const correctUnit = correctMatch[2] || '';

  // Numbers must match exactly
  if (userNumber !== correctNumber) return false;

  // If no units, it's a match
  if (!correctUnit && !userUnit) return true;

  // Check if units match after normalization
  const normalizedUserUnit = normalizeUnit(userUnit);
  const normalizedCorrectUnit = normalizeUnit(correctUnit);

  return normalizedUserUnit === normalizedCorrectUnit;
}

/**
 * Fuzzy match user answer against correct answer
 * Tries multiple matching strategies in order of strictness
 */
export function fuzzyMatchAnswer(userAnswer, correctAnswer) {
  const normalizedUser = normalize(userAnswer);
  const normalizedCorrect = normalize(correctAnswer);
  const compactUser = normalizeCompact(userAnswer);
  const compactCorrect = normalizeCompact(correctAnswer);

  // Convert number words in both answers
  const userWithNumbers = convertNumberWords(normalizedUser);
  const correctWithNumbers = convertNumberWords(normalizedCorrect);

  // 1. Exact match after normalization
  if (normalizedUser === normalizedCorrect) {
    return true;
  }

  // 2. Exact match after compact normalization (handles hyphen/space variations)
  if (compactUser === compactCorrect) {
    return true;
  }

  // 3. Match after converting number words (e.g., "three" vs "3")
  if (userWithNumbers === correctWithNumbers) {
    return true;
  }

  // 4. Handle numeric ranges (e.g., "10 to 25", "10-25")
  if (matchesRange(normalizedUser, normalizedCorrect)) {
    return true;
  }

  // 5. Handle "or" alternatives (e.g., "same or identical")
  if (matchesAlternatives(normalizedUser, normalizedCorrect)) {
    return true;
  }

  // 6. Handle numeric answers with units (e.g., "30 seconds" vs "30s")
  if (matchesNumericWithUnits(normalizedUser, normalizedCorrect)) {
    return true;
  }

  // If we get here, no match - be strict to avoid false positives
  // like "VirtualMachine" matching "VirtualMachineInstance" or "RAID1" matching "RAID10"
  return false;
}
