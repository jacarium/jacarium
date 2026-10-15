import { ChevronRight, Home } from 'lucide-react';

export default function Breadcrumbs({ currentPage, onNavigate }) {
  const pageTitle = currentPage === 'home' ? 'Home'
    : currentPage === 'documents' ? 'Documents'
    : currentPage === 'diagnostics' ? 'Diagnostics'
    : 'Search';

  return (
    <nav className="flex items-center gap-2 text-sm mb-4">
      <button
        onClick={() => onNavigate('home')}
        className="flex items-center gap-1 text-os-blue hover:text-os-blue-hover transition-colors"
      >
        <span>Home</span>
      </button>
      {currentPage !== 'home' && (
        <>
          <ChevronRight size={14} className="text-os-text-muted" />
          <span className="text-os-text-primary font-medium">{pageTitle}</span>
        </>
      )}
    </nav>
  );
}
