/**
 * Markdown to Jira Syntax Converter
 * Converts GitHub-flavored Markdown to Jira's textile-like syntax
 */

/**
 * Convert Markdown to Jira syntax
 * @param {string} markdown - Markdown text
 * @returns {string} - Jira-formatted text
 */
export function markdownToJira(markdown) {
  if (!markdown) return '';

  let jira = markdown;

  // Headers (must be done before other replacements)
  jira = jira.replace(/^######\s+(.+)$/gm, 'h6. $1');
  jira = jira.replace(/^#####\s+(.+)$/gm, 'h5. $1');
  jira = jira.replace(/^####\s+(.+)$/gm, 'h4. $1');
  jira = jira.replace(/^###\s+(.+)$/gm, 'h3. $1');
  jira = jira.replace(/^##\s+(.+)$/gm, 'h2. $1');
  jira = jira.replace(/^#\s+(.+)$/gm, 'h1. $1');

  // Bold: **text** or __text__ -> *text*
  jira = jira.replace(/\*\*(.+?)\*\*/g, '*$1*');
  jira = jira.replace(/__(.+?)__/g, '*$1*');

  // Italic: *text* or _text_ -> _text_
  // Handle single asterisks that aren't part of bold
  jira = jira.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');
  jira = jira.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '_$1_');

  // Strikethrough: ~~text~~ -> -text-
  jira = jira.replace(/~~(.+?)~~/g, '-$1-');

  // Inline code: `code` -> {{code}}
  jira = jira.replace(/`([^`]+)`/g, '{{$1}}');

  // Code blocks: ```language\ncode\n``` -> {code:language}\ncode\n{code}
  jira = jira.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    if (lang) {
      return `{code:${lang}}\n${code.trim()}\n{code}`;
    }
    return `{code}\n${code.trim()}\n{code}`;
  });

  // Links: [text](url) -> [text|url]
  jira = jira.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');

  // Images: ![alt](url) -> !url!
  jira = jira.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '!$2!');

  // Unordered lists: - item or * item -> * item
  jira = jira.replace(/^[-*]\s+(.+)$/gm, '* $1');
  jira = jira.replace(/^ {2}[-*]\s+(.+)$/gm, '** $1');
  jira = jira.replace(/^ {4}[-*]\s+(.+)$/gm, '*** $1');

  // Ordered lists: 1. item -> # item
  jira = jira.replace(/^\d+\.\s+(.+)$/gm, '# $1');
  jira = jira.replace(/^ {2}\d+\.\s+(.+)$/gm, '## $1');
  jira = jira.replace(/^ {4}\d+\.\s+(.+)$/gm, '### $1');

  // Blockquotes: > text -> bq. text
  jira = jira.replace(/^>\s+(.+)$/gm, 'bq. $1');

  // Horizontal rule: --- or *** -> ----
  jira = jira.replace(/^([-*_]){3,}$/gm, '----');

  // Tables (basic support)
  jira = jira.replace(/^\|(.+)\|$/gm, (match, content) => {
    const cells = content.split('|').map(cell => cell.trim());
    return '|' + cells.join('|') + '|';
  });
  jira = jira.replace(/^\|[-\s:|]+\|$/gm, ''); // Remove separator lines

  return jira;
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} - Success status
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    // Fallback for older browsers
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      return success;
    } catch (fallbackError) {
      console.error('Fallback copy failed:', fallbackError);
      return false;
    }
  }
}
