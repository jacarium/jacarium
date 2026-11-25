import { forwardRef } from 'react';
import ContextMenu, { ContextMenuItem, ContextMenuDivider, ContextMenuLabel, ContextSubmenu } from '../../common/menus/ContextMenu';
import { clipboardMenuState, clipboardShortcuts } from '../../../utils/editorClipboard';
import { spellingHintLabel } from '../../../utils/editorSurface';

/**
 * TextSelectionMenu - the Documents editor's right-click menu, on the shared
 * ContextMenu (its first item takes the focus; Arrow keys, Home / End,
 * Enter, Escape; the editor gets the focus back when the menu goes). The
 * editor's selection stays painted meanwhile - CodeMirror draws it from
 * its state, focused or not - so the user sees what Cut / Copy / Ask AI
 * will act on.
 *
 *   Cut / Copy / Paste, with the platform's shortcuts, enabled as the keys
 *   would be: Cut with a selection in an editable editor, Paste in an
 *   editable editor unless the clipboard is known to be empty
 *   (src/utils/editorClipboard.js). Without a selection the menu is Paste
 *   alone - Cut and Copy are not shown, there is nothing for them to act on
 *   (Cut in a read-only editor with a selection stays, disabled: that is
 *   worth knowing). A read-only editor without a selection still opens the
 *   menu, with its one disabled Paste, so the menu is the same gesture
 *   everywhere and the browser's own menu never takes its place.
 *
 *   With a selection, after a separator: Ask AI About This (opens Quick AI
 *   with the selection as context), Add as AI Context (a new AI Chat with
 *   the selection attached, redacted), Search In (submenu with engine
 *   templates).
 *
 *   In the desktop app, when the click landed on a word the spell checker
 *   flagged (`spell`: the word and up to six suggestions, from the main
 *   process - electron/spellcheck.cjs), the suggestions come first, then
 *   "Add to dictionary", then a separator; choosing a suggestion replaces
 *   the word (onReplaceWord: an ordinary edit of the editor, undoable). A
 *   browser shows no such items - a page cannot read its spell checker:
 *   Shift + right-click opens the browser's own menu, and while spell
 *   checking is on this menu says so in a last, disabled row (`spellingHint`;
 *   never in the desktop app).
 */
const TextSelectionMenu = forwardRef(function TextSelectionMenu({
  visible,
  x,
  y,
  selectedText = '',
  editable = true,
  clipboard = 'unknown',
  mac,
  onCut,
  onCopy,
  onPaste,
  onAskAI,
  onAddAsContext,
  onSearchIn,
  engineTemplates = [],
  spell = null,
  spellingHint = false,
  onReplaceWord,
  onAddWord,
  onClose,
}, ref) {
  if (!visible) return null;

  const hasSelection = !!(selectedText && selectedText.trim());
  const enabled = clipboardMenuState({ hasSelection, editable, clipboard });
  const keys = clipboardShortcuts(mac);

  // Group templates by category
  const categorizedTemplates = engineTemplates.reduce((acc, template) => {
    const category = template.category || 'General';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(template);
    return acc;
  }, {});

  const categories = Object.keys(categorizedTemplates).sort();

  return (
    <ContextMenu ref={ref} isVisible={visible} x={x} y={y} zIndex={50} onClose={onClose} label="Editor" testId="editor-context-menu">
      {spell && spell.misspelledWord && (
        <>
          {spell.suggestions.length === 0 && <ContextMenuItem label="No suggestions" action="spelling" disabled onClick={() => {}} testId="spell-no-suggestions" />}
          {spell.suggestions.map((suggestion) => (
            <ContextMenuItem key={suggestion} label={suggestion} action="spelling" onClick={() => onReplaceWord?.(suggestion)} testId="spell-suggestion" />
          ))}
          <ContextMenuItem label="Add to dictionary" action="addWord" onClick={() => onAddWord?.(spell.misspelledWord)} testId="spell-add-word" />
          <ContextMenuDivider />
        </>
      )}
      {hasSelection && <ContextMenuItem label="Cut" action="cut" shortcut={keys.cut} disabled={!enabled.cut} onClick={() => onCut?.()} testId="selection-cut" />}
      {hasSelection && <ContextMenuItem label="Copy" action="copy" shortcut={keys.copy} disabled={!enabled.copy} onClick={() => onCopy?.()} testId="selection-copy" />}
      <ContextMenuItem label="Paste" action="paste" shortcut={keys.paste} disabled={!enabled.paste} onClick={() => onPaste?.()} testId="selection-paste" />

      {hasSelection && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem label="Ask AI About This" action="aiContext" onClick={() => onAskAI?.()} testId="selection-ask-ai" />
          {onAddAsContext && (
            <ContextMenuItem label="Add as AI Context" action="aiContext" onClick={() => onAddAsContext?.()} testId="selection-add-context" />
          )}

          {/* Search In: the engine templates by category, in the shared submenu (its own popup beside the row) */}
          {engineTemplates.length > 0 && (
            <ContextSubmenu label="Search In" action="searchIn" testId="selection-search-in">
              {categories.map((category) => (
                <div key={category}>
                  <ContextMenuLabel label={category} />
                  {categorizedTemplates[category].map((template) => (
                    // (handleSearchInEngine closes the whole menu)
                    <ContextMenuItem key={template.id} label={template.name} onClick={() => { onSearchIn?.(template); onClose?.(); }} />
                  ))}
                </div>
              ))}
            </ContextSubmenu>
          )}
        </>
      )}
      {spellingHint && (
        <>
          <ContextMenuDivider />
          {/* not an action: where the browser keeps the spelling suggestions this menu cannot show */}
          <ContextMenuItem label={spellingHintLabel(mac)} action="spelling" disabled onClick={() => {}} testId="spell-browser-hint" />
        </>
      )}
    </ContextMenu>
  );
});

export default TextSelectionMenu;
