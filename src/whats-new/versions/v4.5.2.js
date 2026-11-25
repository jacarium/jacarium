// Release notes for 4.5.2 (written by hand from v4.5.1..HEAD).
export const version = '4.5.2';
export const date = '2026-11-25';

export const features = [
  {
    id: 1,
    category: 'DOCUMENTS',
    content: [
      {
        type: 'list',
        items: [
          "In the document editor, hovering Search In on the right-click menu no longer moves the whole menu up the window when it was opened low in a document: the menu stays where it opened and only the Search In list places itself beside it, opening to the left or moving up when there is no room, and scrolling when it is long",
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
          "New tests in Chromium, WebKit and the desktop app open the menu near the bottom and the top of the editor, in a wide and a narrow window, and check that the menu does not move, that the list stays on screen and that the pointer can reach its last row",
        ]
      }
    ]
  }
];
