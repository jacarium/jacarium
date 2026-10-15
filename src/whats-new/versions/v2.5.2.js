// Hand-written entry; the categories were assigned when the window moved to
// category groups (scripts/whats-new-from-git.cjs has the rules).
export const version = '2.5.2';
export const date = null;

export const features = [
  {
    id: 1,
    category: 'DOCUMENTS',
    title: 'Documents Changes',
    content: [
      { type: 'text', value: 'Improved document creation workflow to be category-aware.' },
      { type: 'text', value: 'When creating a new document using the "Add New" button, it will now be created in the same category as the currently active document. If no document is selected, it defaults to the General category.' }
    ]
  },
  {
    id: 2,
    category: 'MISC',
    title: 'New Tools Added',
    content: [
      { type: 'text', value: 'Added three new tools to enhance your productivity:' },
      { type: 'text', value: 'IPv4 Subnet Calculator - Calculate subnet mask, network address, broadcast address, first/last host, total/usable hosts, IP class, and binary representation for IPv4 networks.' },
      { type: 'text', value: 'IPv6 Subnet Calculator - Calculate network address, first/last address, address type (Global Unicast, Link-Local, etc.), and binary representation for IPv6 networks. Supports both compressed and expanded IPv6 formats.' },
      { type: 'text', value: 'Cron Parser - Parse and understand cron expressions with human-readable descriptions, field breakdowns, and next execution times. Includes common examples and format help.' }
    ]
  },
  {
    id: 3,
    category: 'MISC',
    title: 'Timer Tools Enhancement',
    content: [
      { type: 'text', value: 'Added pause and resume functionality to Stopwatch and Countdown Timer tools.' },
      { type: 'text', value: 'You can now pause either tool mid-run and resume from where you left off, making it easier to manage timing tasks without losing your progress.' }
    ]
  }
];
