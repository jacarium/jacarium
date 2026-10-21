import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { protectPlaceholdersForMarkdown } from '../../utils/aiContext';

/**
 * Memoized markdown renderer for a single AI chat message.
 *
 * Why this exists: AIChatPage and AIChatSidebar used to call marked() inline
 * inside their messages.map(...) render bodies. During response streaming,
 * every incoming token triggers a setConversations() with a new messages
 * array, so EVERY message in the conversation was re-parsed by marked() on
 * every chunk - O(total conversation length) parsing work per token - even
 * though only the last message's content changes. Wrapping the per-message
 * rendering in React.memo (plus a useMemo keyed on content/citations as a
 * second line of defense) means only the message whose content actually
 * changed gets re-parsed.
 *
 * The rendering output is intentionally byte-identical to the previous
 * inline code in both call sites, including the citation filtering /
 * renumbering path from AIChatPage (which depends on `content` AND
 * `citations` together - both are memo keys).
 *
 * Memoization contract for callers:
 *  - `className` must be a string (value-compared, safe to build inline)
 *  - `style` (optional) and `citations` must be reference-stable across
 *    renders for unchanged messages (hoist style objects to module scope)
 *  - `onCitationClick` must be reference-stable (useCallback)
 */
const AIMessageMarkdown = React.memo(function AIMessageMarkdown({
  content,
  citations,
  onCitationClick,
  className,
  style
}) {
  const { html, displayCitations } = useMemo(() => {
    // Process citations: filter referenced ones and renumber sequentially
    if (citations && citations.length > 0) {
      // Filter citations to only those referenced in the message content
      const referencedCitations = citations.filter(citation => {
        const citationPattern = new RegExp(`\\[${citation.number}\\]`, 'g');
        return citationPattern.test(content);
      });

      if (referencedCitations.length > 0) {
        // Create mapping from original to new sequential numbers
        const citationMap = new Map();
        referencedCitations.forEach((citation, index) => {
          citationMap.set(citation.number, index + 1);
        });

        // Replace citation numbers in content
        let processedContent = content;
        // Sort by citation number descending to avoid replacing [1] before [10]
        const sortedCitations = [...referencedCitations].sort((a, b) => b.number - a.number);
        sortedCitations.forEach(citation => {
          const oldNumber = citation.number;
          const newNumber = citationMap.get(oldNumber);
          const pattern = new RegExp(`\\[${oldNumber}\\]`, 'g');
          processedContent = processedContent.replace(pattern, `[${newNumber}]`);
        });

        // Create renumbered citation list
        const renumberedCitations = referencedCitations.map((citation, index) => ({
          ...citation,
          displayNumber: index + 1
        }));

        return { html: DOMPurify.sanitize(marked(protectPlaceholdersForMarkdown(processedContent))), displayCitations: renumberedCitations };
      }
    }

    // No citations or none referenced - just show content
    // (a [REDACTED_...] placeholder stays literal text - see protectPlaceholdersForMarkdown)
    return { html: DOMPurify.sanitize(marked(protectPlaceholdersForMarkdown(content))), displayCitations: null };
  }, [content, citations]);

  if (displayCitations) {
    return (
      <>
        <div
          className={className}
          style={style}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div className="mt-4 pt-3 border-t border-os-border">
          <div className="text-[10px] font-semibold text-os-text-muted mb-2">Sources:</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {displayCitations.map((citation) => (
              <button
                key={citation.number}
                onClick={() => onCitationClick(citation.doc_id)}
                className="flex items-start gap-2 text-[10px] text-os-text-secondary hover:text-blue-500 transition-colors text-left p-2 rounded-sm hover:bg-os-card-secondary"
              >
                <span className="font-mono font-semibold text-os-text-muted shrink-0">[{citation.displayNumber}]</span>
                <div className="flex-1 min-w-0">
                  <div className="truncate">{citation.doc_title}</div>
                  <div className="text-os-text-muted truncate">({citation.doc_category})</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <div
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export default AIMessageMarkdown;
