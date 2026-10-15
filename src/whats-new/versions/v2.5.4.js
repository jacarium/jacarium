// Hand-written entry; the categories were assigned when the window moved to
// category groups (scripts/whats-new-from-git.cjs has the rules).
export const version = '2.5.4';
export const date = null;

export const features = [
  {
    id: 1,
    category: 'TEAM',
    title: 'AI Quiz',
    content: [
      { type: 'text', value: 'You can now upload documentation files to generate quiz questions.' },
      { type: 'text', value: 'Added optional topic field for "From URL" and "From File" modes. When generating questions from large documents or URLs, you can now specify a specific topic to focus on (e.g., "Installation", "Networking").' },
      { type: 'text', value: 'The AI will analyze your uploaded document or URL and create technical questions based on the actual content, perfect for testing knowledge on specific documentation or training materials.' }
    ]
  }
];
