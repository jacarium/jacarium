// Hand-written entry; the categories were assigned when the window moved to
// category groups (scripts/whats-new-from-git.cjs has the rules).
export const version = '2.5.0';
export const date = null;

export const features = [
  {
    id: 1,
    category: 'CALENDAR',
    title: 'Calendar Sync Fixes',
    content: [
      { type: 'text', value: 'Fixed calendar sync to properly remove events deleted from Google Calendar.' },
      { type: 'text', value: 'Fixed all-day events appearing on wrong day due to timezone handling.' },
      { type: 'text', value: 'Calendar sync now only updates events within the viewed time range, preserving cached events from other months.' }
    ]
  },
  {
    id: 2,
    category: 'MISC',
    title: 'Tooling Around',
    content: [
      { type: 'text', value: 'Added new Tools page with 38+ developer utilities organized into 8 categories:' },
      { type: 'text', value: 'Calculate: Hash Calculator (MD5, SHA1, SHA256, SHA384, SHA512), SLA Calculator' },
      { type: 'text', value: 'Conversion: Base64, Color Converter, CSV/JSON, HTML to Markdown, JSON/YAML, XML to JSON, Number Base Converter, String Utilities, Time Format Converter' },
      { type: 'text', value: 'Encode/Decode: Backslash Escape, HTML Entities, JWT Decoder, URL Encoder/Decoder' },
      { type: 'text', value: 'Format: CSS, HTML, JSON, SQL Formatters' },
      { type: 'text', value: 'Generate: Barcode, CSR, JSON to TypeScript Interface, Lorem Ipsum, QR Code, UUID' },
      { type: 'text', value: 'Miscellaneous: Countdown Timer, Markdown Preview, Stopwatch, String Analyzer, Text Diff, URL Exploder' },
      { type: 'text', value: 'Networking: WHOIS Lookup' },
      { type: 'text', value: 'Validate: IBAN Validator, Regex Validator' }
    ]
  }
];
