import { Home, Search, FileText, Activity, Workflow } from 'lucide-react';

export default function OpenShiftSidebar({ isOpen, currentPage, onPageChange }) {

  return (
    <nav className={`bg-os-sidebar shrink-0 flex flex-col font-text transition-all duration-300 ${isOpen ?'w-64':'w-16'}`} style={{ zIndex: 10 }}>
      {/* Simple menu items */}
      <div className="py-2 px-2 flex flex-col gap-1">
        <button
          onClick={() => onPageChange('home')}
          className={`flex items-center gap-3 px-1.5 py-1.5 text-sm w-full transition-colors ${
 currentPage ==='home'
 ?'bg-os-sidebar-hover text-white'
 :'text-white/80 hover:bg-os-sidebar-hover hover:text-white'
 } ${!isOpen ?'justify-center':'text-left'}`}
          title={!isOpen ? 'Home' : ''}
        >
          <Home size={18} />
          {isOpen && <span>Home</span>}
        </button>
        <button
          onClick={() => onPageChange('documents')}
          className={`flex items-center gap-3 px-1.5 py-1.5 text-sm w-full transition-colors ${
 currentPage ==='documents'
 ?'bg-os-sidebar-hover text-white'
 :'text-white/80 hover:bg-os-sidebar-hover hover:text-white'
 } ${!isOpen ?'justify-center':'text-left'}`}
          title={!isOpen ? 'Documents' : ''}
        >
          <FileText size={18} />
          {isOpen && <span>Documents</span>}
        </button>
        <button
          onClick={() => onPageChange('workflow')}
          className={`flex items-center gap-3 px-1.5 py-1.5 text-sm w-full transition-colors ${
 currentPage ==='workflow'
 ?'bg-os-sidebar-hover text-white'
 :'text-white/80 hover:bg-os-sidebar-hover hover:text-white'
 } ${!isOpen ?'justify-center':'text-left'}`}
          title={!isOpen ? 'Workflow Builder' : ''}
        >
          <Workflow size={18} />
          {isOpen && <span>Workflow Builder</span>}
        </button>
        <button
          onClick={() => onPageChange('diagnostics')}
          className={`flex items-center gap-3 px-1.5 py-1.5 text-sm w-full transition-colors ${
 currentPage ==='diagnostics'
 ?'bg-os-sidebar-hover text-white'
 :'text-white/80 hover:bg-os-sidebar-hover hover:text-white'
 } ${!isOpen ?'justify-center':'text-left'}`}
          title={!isOpen ? 'Diagnostics' : ''}
        >
          <Activity size={18} />
          {isOpen && <span>Diagnostics</span>}
        </button>
        <button
          onClick={() => onPageChange('search')}
          className={`flex items-center gap-3 px-1.5 py-1.5 text-sm w-full transition-colors ${
 currentPage ==='search'
 ?'bg-os-sidebar-hover text-white'
 :'text-white/80 hover:bg-os-sidebar-hover hover:text-white'
 } ${!isOpen ?'justify-center':'text-left'}`}
          title={!isOpen ? 'Search' : ''}
        >
          <Search size={18} />
          {isOpen && <span>Search</span>}
        </button>
      </div>
    </nav>
  );
}
