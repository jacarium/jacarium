/**
 * Convert Markdown text to JIRA syntax
 */
export function convertMarkdownToJira(markdown) {
  let jira = markdown;

  // Headers
  jira = jira.replace(/^######\s+(.+)$/gm, 'h6. $1');
  jira = jira.replace(/^#####\s+(.+)$/gm, 'h5. $1');
  jira = jira.replace(/^####\s+(.+)$/gm, 'h4. $1');
  jira = jira.replace(/^###\s+(.+)$/gm, 'h3. $1');
  jira = jira.replace(/^##\s+(.+)$/gm, 'h2. $1');
  jira = jira.replace(/^#\s+(.+)$/gm, 'h1. $1');

  // Bold
  jira = jira.replace(/\*\*(.+?)\*\*/g, '*$1*');
  jira = jira.replace(/__(.+?)__/g, '*$1*');

  // Italic
  jira = jira.replace(/\*(.+?)\*/g, '_$1_');
  jira = jira.replace(/_(.+?)_/g, '_$1_');

  // Strikethrough
  jira = jira.replace(/~~(.+?)~~/g, '-$1-');

  // Code blocks (must be before inline code to avoid ``` being converted to {{`}})
  jira = jira.replace(/```(\w+)?\n([\s\S]+?)```/g, (match, lang, code) => {
    return `{code${lang ? ':' + lang : ''}}\n${code}{code}`;
  });

  // Code inline
  jira = jira.replace(/`(.+?)`/g, '{{$1}}');

  // Blockquotes
  jira = jira.replace(/^>\s+(.+)$/gm, 'bq. $1');

  // Unordered lists
  jira = jira.replace(/^[*-]\s+(.+)$/gm, '* $1');

  // Ordered lists
  jira = jira.replace(/^\d+\.\s+(.+)$/gm, '# $1');

  // Links
  jira = jira.replace(/\[(.+?)\]\((.+?)\)/g, '[$1|$2]');

  // Images
  jira = jira.replace(/!\[(.+?)\]\((.+?)\)/g, '!$2|alt=$1!');

  // Horizontal rule
  jira = jira.replace(/^---+$/gm, '----');

  // Tables - basic conversion
  jira = jira.replace(/\|(.+)\|/g, (match, content) => {
    return '|' + content + '|';
  });
  jira = jira.replace(/\|\s*-+\s*\|/g, ''); // Remove markdown table separators

  return jira;
}

/**
 * Convert JIRA syntax to Markdown
 */
export function convertJiraToMarkdown(jira) {
  let markdown = jira;

  // Headers
  markdown = markdown.replace(/^h6\.\s+(.+)$/gm, '###### $1');
  markdown = markdown.replace(/^h5\.\s+(.+)$/gm, '##### $1');
  markdown = markdown.replace(/^h4\.\s+(.+)$/gm, '#### $1');
  markdown = markdown.replace(/^h3\.\s+(.+)$/gm, '### $1');
  markdown = markdown.replace(/^h2\.\s+(.+)$/gm, '## $1');
  markdown = markdown.replace(/^h1\.\s+(.+)$/gm, '# $1');

  // Bold
  markdown = markdown.replace(/\*(.+?)\*/g, '**$1**');

  // Italic
  markdown = markdown.replace(/_(.+?)_/g, '*$1*');

  // Strikethrough
  markdown = markdown.replace(/-(.+?)-/g, '~~$1~~');

  // Code blocks (must be before inline code)
  markdown = markdown.replace(/\{code(?::(\w+))?\}([\s\S]+?)\{code\}/g, (match, lang, code) => {
    return '```' + (lang || '') + '\n' + code + '```';
  });

  // Code inline
  markdown = markdown.replace(/\{\{(.+?)\}\}/g, '`$1`');

  // Blockquotes
  markdown = markdown.replace(/^bq\.\s+(.+)$/gm, '> $1');

  // Links
  markdown = markdown.replace(/\[(.+?)\|(.+?)\]/g, '[$1]($2)');

  // Images
  markdown = markdown.replace(/!(.+?)(?:\|alt=(.+?))?!/g, '![$2]($1)');

  return markdown;
}
