/**
 * The CodeMirror editor as a React component, in the place of
 * DocumentEditor's <textarea>: one EditorView for the component's life,
 * handed to the parent through `onSurface` (the CodeMirrorSurface that
 * answers the textarea's API), the props applied as they change.
 *
 *   value        the document of a local document (controlled, like the
 *                textarea's `value`): applied when it differs from the view,
 *                never while a live document is bound (the Y.Text is the
 *                document then; `defaultValue` seeds the view until it is)
 *   yjs          { ytext, awareness } of a live document once the hook is
 *                ready, else null; bound through y-codemirror.next
 *   readOnly, placeholder, spellcheck
 *   docLinkResolver  the [[doc:...]] chips' titles (src/utils/docLinks.js), re-applied as it changes
 *   the handlers (onChange, onKeyDown, onKeyUp, onContextMenu, onSelect,
 *                onClick, onMouseUp, onFocus, onBlur): read through a ref,
 *                so the surface always calls the latest render's closures
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { CodeMirrorSurface } from './CodeMirrorSurface';

export default function CodeMirrorEditor({
  value,
  defaultValue = '',
  yjs = null,
  readOnly = false,
  placeholder = '',
  spellcheck = true,
  docLinkResolver = null,
  onSurface,
  onChange,
  onKeyDown,
  onKeyUp,
  onContextMenu,
  onSelect,
  onClick,
  onMouseUp,
  onFocus,
  onBlur,
  className = '',
  style,
}) {
  const hostRef = useRef(null);
  const surfaceRef = useRef(null);
  const handlersRef = useRef({});
  useLayoutEffect(() => {
    handlersRef.current = { onChange, onKeyDown, onKeyUp, onContextMenu, onSelect, onClick, onMouseUp, onFocus, onBlur };
  });
  const initial = useRef({ doc: value != null ? value : defaultValue, readOnly, placeholder, spellcheck, onSurface, docLinkResolver });

  useLayoutEffect(() => {
    const host = hostRef.current;
    const init = initial.current;
    const handlers = {};
    for (const name of ['onChange', 'onKeyDown', 'onKeyUp', 'onContextMenu', 'onSelect', 'onClick', 'onMouseUp', 'onFocus', 'onBlur']) {
      handlers[name] = (...args) => handlersRef.current[name]?.(...args);
    }
    const surface = new CodeMirrorSurface({ parent: host, doc: init.doc, readOnly: init.readOnly, placeholder: init.placeholder, spellcheck: init.spellcheck, handlers, docLinkResolver: init.docLinkResolver });
    surfaceRef.current = surface;
    init.onSurface?.(surface);
    return () => {
      init.onSurface?.(null);
      surfaceRef.current = null;
      surface.destroy();
    };
  }, []);

  // a live document: bound once its text exists, unbound on a switch away from it
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (yjs && yjs.ytext) surface.bindYjs(yjs.ytext, yjs.awareness || null);
    else surface.unbindYjs();
  }, [yjs]);

  // a local document's controlled value (not while the Y.Text owns the document)
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || surface.managesYjs || value == null) return;
    if (surface.value !== value) surface.value = value;
  }, [value, yjs]);

  useEffect(() => { if (surfaceRef.current) surfaceRef.current.readOnly = readOnly; }, [readOnly]);
  useEffect(() => { if (surfaceRef.current) surfaceRef.current.placeholder = placeholder; }, [placeholder]);
  useEffect(() => { if (surfaceRef.current) surfaceRef.current.spellcheck = spellcheck; }, [spellcheck]);
  // the [[doc:...]] chips follow the documents (their titles): a new resolver per change of the list
  useEffect(() => { if (surfaceRef.current) surfaceRef.current.setDocLinkResolver(docLinkResolver); }, [docLinkResolver]);

  return <div ref={hostRef} className={`sc-editor-cm-host ${className}`} style={style} data-testid="editor-codemirror" />;
}
