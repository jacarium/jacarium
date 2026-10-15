// Hand-written entry; the categories were assigned when the window moved to
// category groups (scripts/whats-new-from-git.cjs has the rules).
export const version = '2.5.5';
export const date = '2026-07-26';

export const features = [
  {
    id: 1,
    category: 'TEAM',
    title: 'Quiz Improvements',
    content: [
      { type: 'text', value: 'Added new Quiz game mode Grid.' },
      { type: 'text', value: 'Refactor the code for Quiz.' }
    ]
  },
  {
    id: 2,
    category: 'SETTINGS',
    title: 'Offline Mode',
    content: [
      { type: 'text', value: 'New Offline Mode switch in Settings > General, ON by default. While it is on the application makes no outbound network connections at all: Cloud Sync, Jira, Google Calendar, remote AI providers, URL fetching, WHOIS, update checks and workflow REST API / SSH nodes are refused with a clear message. Only connections to this machine (the local backend, a local Ollama) are allowed; links still open in your system browser.' },
      { type: 'text', value: 'The switch is enforced centrally in the desktop shell and the local backend, not just per feature, and a small cloud-off icon in the bottom-right corner (next to the FPS counter when that is enabled) shows when it is active. Turn it off in Settings to re-enable sync and the other network features; it applies immediately, no restart needed.' },
      { type: 'text', value: 'Fonts and the Diagnostics charts are now bundled with the app instead of being loaded from a CDN, so they work with Offline Mode on.' }
    ]
  }
];
