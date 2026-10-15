/**
 * Hand a workflow to the AI chat sidebar as context ("Add as AI Context" in
 * the workflow list and tab menus): open the sidebar, then - once it has
 * had a moment to mount - send the workflow.
 */
export function addWorkflowAsAIContext(workflow) {
  // Open AI Chat sidebar first
  window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', {
    detail: { isOpen: true }
  }));

  // Add context after a short delay to ensure sidebar is mounted
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('addAIContext', {
      detail: {
        contextType: `Workflow: ${workflow.title}`,
        contextData: workflow
      }
    }));
  }, 100);
}
