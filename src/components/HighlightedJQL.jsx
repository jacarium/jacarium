import { highlightJQLForReact } from '../utils/jqlHighlighter';

export default function HighlightedJQL({ jql }) {
  const parts = highlightJQLForReact(jql);

  if (!jql) {
    return (
      <span className="text-os-text-muted">
        // Build your query by adding rules above...
      </span>
    );
  }

  return (
    <span className="leading-relaxed">
      {parts.map((part, index) => {
        switch (part.type) {
          case 'keyword':
            return (
              <span key={index} className="text-yellow-400 font-bold">
                {part.text}
              </span>
            );
          case 'string':
            return (
              <span key={index} className="text-green-400">
                {part.text}
              </span>
            );
          case 'function':
            return (
              <span key={index} className="text-blue-400">
                {part.text}
              </span>
            );
          case 'field':
            return (
              <span key={index} className="text-cyan-400">
                {part.text}
              </span>
            );
          case 'placeholder':
            return (
              <span key={index} className="text-os-blue italic font-bold" title="Placeholder for incomplete rule">
                {part.text}
              </span>
            );
          default:
            return <span key={index} className="text-os-text-muted">{part.text}</span>;
        }
      })}
    </span>
  );
}
