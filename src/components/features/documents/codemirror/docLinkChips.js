/**
 * The document links' chips in the editor: every [[doc:<stableId>]] /
 * [[doc:<stableId>|text]] directive (src/utils/docLinks.js) is drawn as a
 * small chip carrying the linked document's CURRENT title (a CodeMirror
 * replace decoration: the text underneath stays the directive, which is
 * what the document - and a live document's shared Y.Text - holds). A
 * target that is not on this device shows a muted "Document not found" chip.
 *
 * The caret and the selection stay sensible: a chip is an atomic range
 * (the caret steps over it, Backspace / Delete remove it whole), and a
 * directive the selection reaches into, or that is being edited, is shown
 * as its text (no chip), so a partly typed or partly deleted directive is
 * always visible. Clicking a chip puts the caret after it.
 *
 * The resolver comes in through a facet the surface reconfigures when the
 * documents change (CodeMirrorSurface.setDocLinkResolver), so a rename
 * reaches every chip; the title-form directive ([[doc:Some title]]) is left
 * as text - the picker converts it.
 */
import { Facet } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { treeChanged, treeFor } from './markdownLanguage';
import { findDocLinks } from '../../../../utils/docLinks';

/** The Markdown nodes a directive is plain text in (the preview prints it as written there: no chip). */
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock']);
function insideCode(tree, pos) {
  for (let node = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

/** The resolver (createDocLinkResolver) the chips read titles from; the last one provided wins. */
export const docLinkResolverFacet = Facet.define({
  combine: (values) => (values.length ? values[values.length - 1] : null),
});

class DocLinkChip extends WidgetType {
  constructor(text, state, raw) {
    super();
    this.text = text;
    this.state = state;   // 'found' | 'missing'
    this.raw = raw;
  }
  eq(other) { return other.text === this.text && other.state === this.state && other.raw === this.raw; }
  toDOM() {
    const span = document.createElement('span');
    span.className = `cm-doc-link-chip${this.state === 'missing' ? ' cm-doc-link-chip-missing' : ''}`;
    span.setAttribute('title', this.state === 'missing' ? `Document not found - ${this.raw}` : `Link to "${this.text}" - ${this.raw}`);
    span.setAttribute('data-doc-link-chip', this.state);
    span.textContent = this.state === 'missing' ? `Document not found: ${this.text}` : this.text;
    return span;
  }
  ignoreEvent() { return false; }
}

/** The chip ranges of the visible text: id-form directives the selection does not touch. Exported for the tests. */
export function docLinkChipRanges(state, visibleRanges, resolve) {
  const marks = [];
  const selection = state.selection.ranges;
  const tree = treeFor(state, visibleRanges.length ? visibleRanges[visibleRanges.length - 1].to : 0);
  for (const { from, to } of visibleRanges) {
    const text = state.sliceDoc(from, to);
    for (const link of findDocLinks(text)) {
      if (!link.byId) continue;
      const start = from + link.from;
      const end = from + link.to;
      if (insideCode(tree, start + 1)) continue;
      // the selection reaches into the directive (or sits strictly inside it): show the text
      const touched = selection.some((r) => (r.empty ? r.head > start && r.head < end : r.from < end && r.to > start));
      if (touched) continue;
      const hit = typeof resolve === 'function' ? resolve(link.ref) : { status: 'missing' };
      const chip = hit && hit.status === 'found'
        ? new DocLinkChip(link.label || hit.title, 'found', link.raw)
        : new DocLinkChip(link.label || link.ref, 'missing', link.raw);
      marks.push(Decoration.replace({ widget: chip, inclusive: false }).range(start, end));
    }
  }
  return Decoration.set(marks, true);
}

const chipsPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = docLinkChipRanges(view.state, view.visibleRanges, view.state.facet(docLinkResolverFacet)); }
  update(update) {
    const resolverChanged = update.startState.facet(docLinkResolverFacet) !== update.state.facet(docLinkResolverFacet);
    if (update.docChanged || update.viewportChanged || update.selectionSet || resolverChanged || treeChanged(update)) {
      this.decorations = docLinkChipRanges(update.state, update.view.visibleRanges, update.state.facet(docLinkResolverFacet));
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
  // the caret steps over a chip; Backspace / Delete take it whole
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || Decoration.none),
});

/** The extension: the chips plugin plus the resolver (null: every link shows as not found until one is set). */
export function docLinkChips(resolve = null) {
  return [docLinkResolverFacet.of(resolve), chipsPlugin];
}
