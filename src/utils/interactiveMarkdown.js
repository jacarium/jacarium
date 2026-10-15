import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { highlightCode, resolveHighlightLanguage } from './codeHighlight';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Configure marked to handle attachment images
const renderer = new marked.Renderer();
const originalImageRenderer = renderer.image.bind(renderer);

// Handle images with attachment: protocol
renderer.image = function(href, title, text) {
  const hrefStr = typeof href === 'string' ? href : (href?.href || '');

  // Check if this is an attachment URL
  if (hrefStr.startsWith('attachment:')) {
    let attachmentPath = hrefStr.substring(11); // Remove 'attachment:' prefix
    let style = 'max-width: 100%; height: auto;';

    // Optional trailing ?width= suffix: bare number or "px" suffix = pixels,
    // "%" suffix = percent. Malformed values simply don't match and fall
    // through to the default style.
    const widthMatch = attachmentPath.match(/\?width=(\d+)(px|%)?$/);
    if (widthMatch) {
      attachmentPath = attachmentPath.slice(0, widthMatch.index);
      const [, value, unit] = widthMatch;
      const widthCss = unit === '%' ? `${value}%` : `${value}px`;
      style = `width: ${widthCss}; height: auto; max-width: 100%;`;
    }

    const filename = attachmentPath;

    // Return a placeholder that will be replaced async
    // We use a special data attribute to identify these for later processing
    const safeFilename = escapeHtml(filename);
    const safeAlt = escapeHtml(text || filename);
    const safeTitle = escapeHtml(title || filename);
    return `<img data-attachment="${safeFilename}" alt="${safeAlt}" title="${safeTitle}" class="attachment-image" style="${style}" />`;
  }

  // For regular images, use the default renderer
  return originalImageRenderer(href, title, text);
};

// Track heading slugs used within a single render so duplicate headings get
// GitHub-style disambiguated ids (first "Foo" -> "foo", second -> "foo-1").
// The renderer below is a module-level singleton shared across every render,
// so this state is reset at the start of each processInteractiveMarkdown()
// call rather than persisting across unrelated documents.
let usedHeadingSlugs = new Map();

// GitHub-Flavored-Markdown-style slug: lowercase, drop characters that are
// not letters/numbers/spaces/underscores/hyphens, collapse whitespace to "-".
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

// Emit id attributes on headings so hand-written GitHub-style ToC links like
// [Challenge 1](#challenge-1) scroll to the matching heading in the preview.
renderer.heading = function(token) {
  const innerHtml = this.parser.parseInline(token.tokens);
  // Slug from the heading's plain text: strip tags, then decode the basic
  // entities marked emits (&amp; decoded last to avoid double-decoding).
  const plainText = innerHtml
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  let slug = slugifyHeading(plainText);
  if (!slug) slug = 'heading';
  const count = usedHeadingSlugs.get(slug) || 0;
  usedHeadingSlugs.set(slug, count + 1);
  const id = count === 0 ? slug : `${slug}-${count}`;
  return `<h${token.depth} id="${id}">${innerHtml}</h${token.depth}>\n`;
};

// ```mermaid fenced blocks become an inert placeholder that keeps the source
// as a plain (escaped) code block; src/utils/mermaidDiagrams.js renders the
// diagram into it asynchronously (preview effect / PDF export) so mermaid
// itself stays a lazily-loaded chunk and this pass stays synchronous.
//
// ```python / ```go / ```bash / ```yaml / ```json fences (and the aliases
// in src/utils/codeHighlight.js) are syntax-highlighted synchronously:
// the same <pre><code class="language-X"> shape marked emits, with the
// escaped code wrapped in <span class="hljs-*"> tokens that index.css
// colours per theme (--os-code-* tokens). No auto-detection: a bare ```
// fence and every other language go through marked's own code renderer
// untouched (plain escaped text).
const originalCodeRenderer = renderer.code.bind(renderer);
renderer.code = function(token) {
  const lang = String(token.lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (lang === 'mermaid') {
    return `<div class="mermaid-diagram" data-mermaid="pending"><pre><code class="language-mermaid">${escapeHtml(token.text)}</code></pre></div>\n`;
  }
  const highlightLang = resolveHighlightLanguage(lang);
  if (highlightLang) {
    // Mirror marked's own normalisation: exactly one trailing newline.
    const source = String(token.text || '').replace(/\n$/, '');
    const highlighted = highlightCode(source, highlightLang);
    if (highlighted !== null) {
      return `<pre><code class="hljs language-${highlightLang}">${highlighted}\n</code></pre>\n`;
    }
  }
  return originalCodeRenderer(token);
};

marked.setOptions({ renderer });

/**
 * Process interactive elements in markdown - BEFORE markdown parsing
 *
 * Supported syntax:
 * - [[input:id:placeholder]] - Text input field
 * - [[textarea:id:placeholder]] - Textarea field
 * - [[checkbox:id:label]] - Checkbox with label
 * - [[button:label:url]] - Button that opens URL
 * - [[submit:templateName:buttonLabel]] - Submit button for templates
 * - [[pagebreak]] - PDF export: following content starts on a fresh page
 * - [[blankpage]] - PDF export: inserts an intentionally-blank page
 * - [[centerpage]] ... [[/centerpage]] - PDF export: the wrapped markdown
 *   gets a page of its own with its content vertically centered (cover /
 *   title pages). Both tags belong on their own lines.
 * - [[header]] ... [[/header]] - PDF export: the wrapped markdown repeats
 *   in the top margin of every page. In the preview it renders inline
 *   where placed.
 * - [[footer]] ... [[/footer]] - PDF export: same, bottom margin of every
 *   page (the automatic page number moves to the right corner beside it).
 * - [[toc]] ... [[/toc]] - marks a generated Table of Contents block so
 *   the PDF export can add right-aligned target page numbers to its
 *   entries (emitted by the editor's Insert Table of Contents button).
 * - ```mermaid fenced code blocks - emitted as .mermaid-diagram
 *   placeholders (see renderer.code above) that
 *   src/utils/mermaidDiagrams.js turns into diagrams after the parse.
 * - ```python / ```go / ```bash / ```yaml / ```json fenced code blocks -
 *   syntax-highlighted synchronously (see renderer.code above and
 *   src/utils/codeHighlight.js); any other fence stays plain text.
 */
export function processInteractiveMarkdown(markdownText) {
  if (!markdownText) return markdownText;

  let processedText = markdownText;

  // Replace [[input:id:placeholder]] with HTML input fields
  processedText = processedText.replace(/\[\[input:([^:]+):([^\]]+)\]\]/g, (match, id, placeholder) => {
    const safeId = escapeHtml(id);
    const safePlaceholder = escapeHtml(placeholder);
    return `<input type="text" id="interactive-input-${safeId}" data-input-id="${safeId}" placeholder="${safePlaceholder}" style="display:inline-block;min-width:200px;padding:0.5rem 0.75rem;border:1px solid #d1d5db;border-radius:var(--radius-sm);margin:0.5rem 0;outline:none;" class="interactive-input" />`;
  });

  // Replace [[textarea:id:placeholder]] with HTML textarea fields
  processedText = processedText.replace(/\[\[textarea:([^:]+):([^\]]+)\]\]/g, (match, id, placeholder) => {
    const safeId = escapeHtml(id);
    const safePlaceholder = escapeHtml(placeholder);
    return `<textarea data-textarea-id="${safeId}" placeholder="${safePlaceholder}" rows="4" style="display:block;width:100%;max-width:600px;padding:0.5rem 0.75rem;border:1px solid #d1d5db;border-radius:var(--radius-sm);margin:0.5rem 0;outline:none;resize:vertical;font-family:inherit;font-size:inherit;" class="interactive-textarea"></textarea>`;
  });

  // Replace [[checkbox:id:label]] with HTML checkboxes
  processedText = processedText.replace(/\[\[checkbox:([^:]+):([^\]]+)\]\]/g, (match, id, label) => {
    const safeId = escapeHtml(id);
    const safeLabel = escapeHtml(label);
    return `<label style="display:inline-flex;align-items:center;gap:0.5rem;margin:0.5rem 0;cursor:pointer;"><input type="checkbox" data-checkbox-id="${safeId}" class="interactive-checkbox" style="width:1rem;height:1rem;cursor:pointer;" /><span style="user-select:none;">${safeLabel}</span></label>`;
  });

  // Replace [[button:label:url]] with HTML buttons for opening URLs.
  // The URL is base64-encoded into a data attribute; DocumentEditor's
  // delegated preview click handler decodes it, substitutes {{variables}}
  // from the interactive form fields, and opens it.
  processedText = processedText.replace(/\[\[button:([^:]+):([^\]]+)\]\]/g, (match, label, url) => {
    const encodedUrl = btoa(url);
    const safeLabel = escapeHtml(label);
    return `<button type="button" style="display:inline-block;padding:0.5rem 1rem;margin:0.5rem 0.5rem;background-color:#2563eb;color:white;border:none;border-radius:var(--radius-sm);cursor:pointer;transition:background-color 0.2s;" data-action="open-url" data-url-b64="${encodedUrl}" class="interactive-button">${safeLabel}</button>`;
  });

  // Replace [[submit:templateName:buttonLabel]] with submit buttons that
  // create documents from templates (handled by DocumentEditor's delegated
  // preview click handler via data-action/data-template-b64).
  processedText = processedText.replace(/\[\[submit:([^:]+):([^\]]+)\]\]/g, (match, templateName, buttonLabel) => {
    const encodedTemplateName = btoa(templateName);
    const safeButtonLabel = escapeHtml(buttonLabel);
    return `<button type="button" style="display:inline-block;padding:0.5rem 1rem;margin:0.5rem 0.5rem;background-color:#10b981;color:white;border:none;border-radius:var(--radius-sm);cursor:pointer;font-weight:500;transition:background-color 0.2s;" data-action="submit-template" data-template-b64="${encodedTemplateName}" class="interactive-submit">${safeButtonLabel}</button>`;
  });

  // Replace [[pagebreak]] / [[blankpage]] PDF layout directives with inert
  // marker divs. In the live preview these render as labeled dashed
  // dividers (styled in index.css, pointer-events disabled); the PDF export
  // (useImportExport.exportDocumentToPDF) finds them via
  // [data-pdf-directive] and turns each into a real page push / blank page.
  // Every directive is emitted with surrounding newlines so that a blank
  // line always separates the marker div from adjacent markdown. Without
  // it, marked's HTML-block rule ("an HTML block runs until a blank line")
  // swallows whatever the author wrote on the very next line into the raw
  // marker block - e.g. "[[centerpage]]\n# Title" would silently eat the
  // title heading.
  processedText = processedText.replace(/\[\[pagebreak\]\]/g,
    '\n<div class="pdf-directive" data-pdf-directive="pagebreak" aria-hidden="true">Page break</div>\n');
  processedText = processedText.replace(/\[\[blankpage\]\]/g,
    '\n<div class="pdf-directive" data-pdf-directive="blankpage" aria-hidden="true">Blank page</div>\n');

  // Wrapping directives ([[centerpage]], [[header]], [[footer]], [[toc]]):
  // each is emitted as a PAIR of standalone marker divs rather than one
  // wrapping div, because marked treats the inside of a block-level HTML
  // element as raw HTML and would skip markdown parsing of the wrapped
  // content. wrapDirectiveBlocks() below groups the rendered siblings
  // between the markers into the real wrapper div after the parse.
  for (const kind of ['centerpage', 'header', 'footer', 'toc']) {
    processedText = processedText
      .replace(new RegExp(`\\[\\[${kind}\\]\\]`, 'g'),
        `\n<div data-pdf-directive="${kind}-start" aria-hidden="true"></div>\n`)
      .replace(new RegExp(`\\[\\[\\/${kind}\\]\\]`, 'g'),
        `\n<div data-pdf-directive="${kind}-end" aria-hidden="true"></div>\n`);
  }

  // Reset per-render heading slug state (the renderer is a module-level
  // singleton, so stale counters would otherwise leak between documents).
  usedHeadingSlugs = new Map();

  // Now parse markdown
  const html = marked(processedText);

  return wrapDirectiveBlocks(DOMPurify.sanitize(html));
}

// The wrapping directive kinds and the wrapper element each pair produces.
// data-pdf-centerpage is kept (in addition to the class) for backward
// compatibility with the export pass that keys off it.
const WRAP_KINDS = [
  { kind: 'centerpage', className: 'pdf-centerpage', attr: 'data-pdf-centerpage' },
  { kind: 'header', className: 'pdf-header', attr: 'data-pdf-header' },
  { kind: 'footer', className: 'pdf-footer', attr: 'data-pdf-footer' },
  { kind: 'toc', className: 'pdf-toc', attr: 'data-pdf-toc' },
];

// Group the rendered siblings between each <kind>-start marker and its
// matching <kind>-end marker into the kind's wrapper div. Runs on the
// sanitized output (see the marker-emission comment above for why this
// cannot happen before the markdown parse). The wrappers are what both the
// live preview styling (index.css) and the PDF export key off.
// An unclosed start tag wraps to the end of its parent; an orphan end tag
// is left as an empty invisible marker div.
function wrapDirectiveBlocks(html) {
  if (!html || !html.includes('-start"')) {
    return html;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const { kind, className, attr } of WRAP_KINDS) {
    let start;
    while ((start = tpl.content.querySelector(`[data-pdf-directive="${kind}-start"]`))) {
      const wrapper = document.createElement('div');
      wrapper.className = className;
      wrapper.setAttribute(attr, '');
      start.parentNode.insertBefore(wrapper, start);
      let node = start;
      while (node) {
        const next = node.nextSibling;
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          node.getAttribute('data-pdf-directive') === `${kind}-end`
        ) {
          node.remove();
          break;
        }
        if (node === start) {
          node.remove(); // marker itself is not content
        } else {
          wrapper.appendChild(node);
        }
        node = next;
      }
    }
  }
  return tpl.innerHTML;
}

/**
 * Extract every heading from a markdown document, in document order, with
 * the exact id the preview/PDF renderer will assign (including duplicate
 * disambiguation), by actually running the same render pipeline and reading
 * the ids off the resulting HTML. This deliberately avoids a second slug
 * implementation that could drift from renderer.heading above; it also means
 * headings inside fenced code blocks are naturally excluded, since marked's
 * tokenizer never treats those as headings.
 *
 * @param {string} markdownText - Full markdown source
 * @returns {Array<{level: number, text: string, id: string}>}
 */
export function extractDocumentHeadings(markdownText) {
  const html = processInteractiveMarkdown(markdownText || '');
  if (!html) return [];
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(parsed.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(el => ({
    level: Number(el.tagName.charAt(1)),
    text: (el.textContent || '').trim(),
    id: el.id,
  }));
}

/**
 * Resolve attachment: URLs in rendered HTML
 * This should be called after rendering to replace placeholder images with actual data
 * @param {HTMLElement} container - The container element with rendered markdown
 */
export async function resolveAttachmentImages(container) {
  if (!container) {
    console.warn('[AttachmentImages] Called with null/undefined container');
    return;
  }

  const attachmentImages = container.querySelectorAll('img[data-attachment]');
  console.log(`[AttachmentImages] Found ${attachmentImages.length} attachment image(s) to resolve`);

  for (const img of attachmentImages) {
    const filename = img.getAttribute('data-attachment');
    if (!filename) {
      console.warn('[AttachmentImages] Image has data-attachment but no filename value');
      continue;
    }

    console.log(`[AttachmentImages] Resolving: ${filename}`);

    try {
      // Check if element is still in DOM (race condition with re-renders)
      if (!container.contains(img)) {
        console.warn(`[AttachmentImages] Image element for "${filename}" was removed from DOM during resolution (race condition)`);
        continue;
      }

      // Lazy import to avoid circular dependencies
      const { getMediaDataUrl } = await import('./media');
      const dataUrl = await getMediaDataUrl(filename);

      // Re-check DOM attachment after async operations
      if (!container.contains(img)) {
        console.warn(`[AttachmentImages] Image element for "${filename}" was removed from DOM after DB lookup (race condition)`);
        continue;
      }

      if (dataUrl) {
        console.log(`[AttachmentImages] Got dataUrl for "${filename}" (length: ${dataUrl.length}, type: ${dataUrl.substring(0, 30)}...)`);
        // Set src and add onload/onerror handlers
        img.onload = () => {
          console.log(`[AttachmentImages] Successfully loaded image: ${filename}`);
          img.removeAttribute('data-attachment');
        };
        img.onerror = (e) => {
          console.error(`[AttachmentImages] Failed to load image: ${filename}`, {
            src: img.src?.substring(0, 50),
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            complete: img.complete,
            error: e
          });
          img.alt = `[Error loading: ${filename}]`;
        };
        img.src = dataUrl;
      } else {
        console.warn(`[AttachmentImages] No data found in DB for "${filename}"`);
        // Image not found in database. Clear the marker attribute (as the
        // success path does) so MutationObserver-driven re-runs stop matching
        // this image — otherwise inserting the error span below triggers the
        // observer, which reprocesses the same image and inserts another span,
        // forever.
        img.removeAttribute('data-attachment');
        img.alt = `[Image not found: ${filename}]`;
        img.style.display = 'none';
        // Add a text node after the image to show the error, unless an
        // identical error span is already there (defense in depth against
        // double-processing).
        const message = `[Image not found: ${filename}]`;
        if (img.nextSibling?.textContent !== message) {
          const errorText = window.document.createElement('span');
          errorText.textContent = message;
          errorText.className = 'text-red-600 text-sm italic';
          img.parentNode?.insertBefore(errorText, img.nextSibling);
        }
      }
    } catch (error) {
      console.error(`[AttachmentImages] Exception resolving "${filename}":`, error);
      img.alt = `[Error loading: ${filename}]`;
      // Don't break, continue with next image
    }
  }

  console.log('[AttachmentImages] Resolution complete');
}
