// Hand-written entry; the categories were assigned when the window moved to
// category groups (scripts/whats-new-from-git.cjs has the rules).
export const version = '2.4.19';
export const date = null;

export const features = [
  {
    id: 1,
    category: 'DIAGNOSTICS',
    title: 'Log View-er',
    content: [
      { type: 'text', value: 'Filter logs within selected severity or process for more precise diagnostics. The new filters work seamlessly together to help you find exactly what you need.' },
      { type: 'text', value: 'Access from Diagnostics → sosreport → Log Viewer.' }
    ]
  },
  {
    id: 2,
    category: 'TEAM',
    title: 'Challenge your friends!',
    content: [
      { type: 'text', value: 'We have added cross-platform support for Quiz! Challenge your friends by sharing the link accessible from Web Browser.' },
      { type: 'text', value: 'Access from Quiz → Select Topic → Create a Lobby → Share Link (Web).' }
    ]
  },
  {
    id: 3,
    category: 'UI',
    title: 'Make it your own!',
    content: [
      { type: 'text', value: 'Customize your Jacarium sidebar with beautiful themes including Magma, Nebula, Vulkan, Sunset, and Aurora.' },
      { type: 'text', value: 'Access them from Application Settings → Theme Settings → Color Scheme to transform your sidebar with vibrant colour.' }
    ]
  }
];
