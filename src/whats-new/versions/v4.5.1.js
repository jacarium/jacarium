// Release notes for 4.5.1 (written by hand from v4.5.0..HEAD).
export const version = '4.5.1';
export const date = '2026-11-23';

export const features = [
  {
    id: 1,
    category: 'DOCUMENTS',
    content: [
      {
        type: 'list',
        items: [
          "In a browser (the home server), Shift + right-click in the document editor now opens the browser's own menu with its spelling suggestions for the word under the pointer; a plain right-click still opens the Jacarium menu, which says so when spellcheck is on. Shift + left-click, Shift + drag and Shift + arrows select as before, and a Shift + right-click inside a selection keeps it. The desktop app is unchanged: it shows the suggestions in its own menu",
          "In a browser, opening the editor menu no longer reads the clipboard, so Safari no longer shows its own Paste bubble on right-click; Paste reads the clipboard only when chosen",
        ]
      }
    ]
  },
  {
    id: 2,
    category: 'TESTS',
    content: [
      {
        type: 'list',
        items: [
          "The editor menu tests run in Chromium and WebKit and cover the spelling hint, the Shift + right-click path and that Shift selection keeps working",
        ]
      }
    ]
  }
];
