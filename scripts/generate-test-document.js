#!/usr/bin/env node

/**
 * Generate a synthetic test document for layout/measurement debugging
 *
 * Prints an N-line document with a realistic mix of line shapes to stdout:
 *   - short lines
 *   - long lines that soft-wrap multiple times at typical editor widths
 *   - indented lines containing tab characters
 *   - a unique needle token (XQZFINDME) near the top (line 5) and near the
 *     bottom (line N-8) for exercising find-in-document highlighting
 *
 * Useful for reproducing DocumentEditor layout/measurement bugs (search
 * highlight positions, gutter line heights, scroll sync) where behavior
 * depends on document length, soft-wrapping, and trailing newlines.
 * Paste the output into a new document, or pipe it into an automation
 * driver that fills the editor textarea.
 *
 * Usage:
 *   node scripts/generate-test-document.js [lines] [--trailing-newlines N]
 *
 * Examples:
 *   node scripts/generate-test-document.js 200 > /tmp/doc200.txt
 *   node scripts/generate-test-document.js 5200 > /tmp/doc5200.txt
 *   # documents ending in blank lines historically triggered distinct
 *   # measurement bugs (textarea counts trailing empty rows, divs do not):
 *   node scripts/generate-test-document.js 200 --trailing-newlines 5 > /tmp/doc200t.txt
 */

const args = process.argv.slice(2);
const lines = parseInt(args.find(a => /^\d+$/.test(a)) || '200', 10);
const trailIdx = args.indexOf('--trailing-newlines');
const trailing = trailIdx !== -1 ? parseInt(args[trailIdx + 1] || '0', 10) : 0;

const NEEDLE = 'XQZFINDME';
const out = [];

for (let i = 1; i <= lines; i++) {
  if (i === lines - 8) {
    out.push(`Line ${i}: near the bottom here is the needle ${NEEDLE} inside a normal line.`);
  } else if (i === 5) {
    out.push(`Line ${i}: near the top here is the needle ${NEEDLE} inside a normal line.`);
  } else if (i % 7 === 0) {
    out.push(`Line ${i}: this is a deliberately long wrapping line with plenty of words so that it soft wraps across the textarea width multiple times, containing troubleshooting output and diagnostic detail padding padding padding padding padding padding padding padding end-of-long-line-${i}`);
  } else if (i % 13 === 0) {
    out.push(`    indented log line ${i} with\ttab characters\tand more text`);
  } else {
    out.push(`Line ${i}: short entry`);
  }
}

process.stdout.write(out.join('\n') + '\n'.repeat(trailing));
