/**
 * "Add as AI Context" on a workflow (the workflow list's menu and the tab
 * menu): the same path as a document or a board - src/utils/
 * aiContextSources.js opens the sidebar, loads the workflow (nodes and
 * edges, as readable Markdown) and hands over a `workflow` payload, which
 * the sidebar turns into a new chat with a "Workflow: <title>" chip.
 */
export { addWorkflowAsAIContext } from './aiContextSources';
