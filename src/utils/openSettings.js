/**
 * Open the Settings dialog from anywhere (a page's menu, the "link this
 * profile to a home server" hint of the team features, a keyboard shortcut):
 * CompactSidebar listens for the event and shows the dialog over whatever
 * page is showing, on the requested tab ('general' | 'integrations' | 'ai' |
 * 'users' | 'audit' | 'about') and, for a tab with sub-tabs, the requested
 * section (Integrations: 'jira' | 'calendar' | 'huggingface').
 */
export function openAppSettings(tab = 'general', { section = null } = {}) {
  if (typeof window === 'undefined') return;
  const EventCtor = window.CustomEvent || CustomEvent;
  window.dispatchEvent(new EventCtor('openAppSettings', { detail: { tab, section } }));
}
