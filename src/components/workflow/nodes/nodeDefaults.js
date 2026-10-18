/**
 * What a node's fields show before the user types into them - the one
 * place for it. A node put on the canvas starts with empty data
 * (useWorkflowCanvas: `data: {}`); the editor's node components fill
 * each field in with these fallbacks (useNodeField) and only an edit
 * writes the value into node.data. So the saved workflow carries NO value
 * for an untouched field, and whoever reads a workflow without the editor
 * - the phone's read-only reader (src/components/mobile/MobileWorkflowView.jsx)
 * - has to fall back the same way, or it shows something else than the
 * desktop: a Transform left as the editor made it showed "return input;"
 * alone on the phone where the desktop shows the two-line default.
 *
 * `nodeFields(node)` gives node.data with every missing or empty field
 * filled in as the editor shows it (the same `value || fallback` the node
 * components use).
 */

export const NODE_FIELD_DEFAULTS = Object.freeze({
  restapi: { url: '', method: 'GET', headers: '', body: '' },
  ssh: { host: '', port: '22', username: '', authMethod: 'agent', password: '', command: '', sshOptions: '', interactive: false },
  transformation: { code: '// Transform input data\nreturn input;' },
  comparison: { operator: '>' },
  delay: { duration: 1000 },
  storage: { variableName: 'data' },
  variablereference: { variableName: 'data' },
  makearray: { delimiter: ',' },
  sequence: { outputCount: 3 },
  switch: { cases: [{ value: 'case1' }, { value: 'case2' }] },
  string: { value: '' },
  text: { value: '' },
  boolean: { value: false },
  object: { value: '{}' },
  array: { value: '[]' },
  note: { text: '' },
  idea: { label: '' },
});

/** The fallback the editor shows for `key` on a node of `type` (undefined when the field has none). */
export function nodeFieldDefault(type, key) {
  return NODE_FIELD_DEFAULTS[type]?.[key];
}

/** node.data as the editor shows it: every missing or empty field filled in with its fallback. */
export function nodeFields(node) {
  const data = node?.data || {};
  const defaults = NODE_FIELD_DEFAULTS[node?.type] || {};
  const filled = { ...data };
  for (const [key, fallback] of Object.entries(defaults)) if (!data[key]) filled[key] = fallback;
  return filled;
}
