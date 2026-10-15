import { BRAND_NAME, brandTagline } from '../brand/brand';
import { Search, FileText, Command, Activity, Workflow, ArrowRight } from 'lucide-react';

const ActionCard = ({ icon: Icon, title, description, onClick }) => {
  return (
    <button
      onClick={onClick}
      className="bg-os-card border border-os-border hover:border-os-border hover:shadow-md transition-all p-6 text-left group"
    >
      <div className="flex items-start gap-4">
        <div className="p-3 bg-os-card-secondary group-hover:bg-os-card-secondary transition-colors">
          <Icon size={24} className="text-os-text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold text-os-text-primary">
              {title}
            </h3>
            <ArrowRight size={18} className="text-os-text-muted group-hover:text-os-text-secondary transition-colors" />
          </div>
          <p className="text-sm text-os-text-secondary leading-relaxed">
            {description}
          </p>
        </div>
      </div>
    </button>
  );
};

export default function HomePage({ onNavigate }) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const metaKey = isMac ? '⌘' : 'Ctrl';

  return (
    <div className="flex-1 bg-os-card min-w-0 overflow-hidden">
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-12 py-12">
          {/* Header */}
          <div className="mb-10">
            <h1 className="text-3xl font-semibold text-os-text-primary mb-2">
              {BRAND_NAME}
            </h1>
            <p className="text-base text-os-text-secondary">
              {brandTagline()}
            </p>
          </div>

          {/* Quick Tip */}
          <div className="bg-os-card-secondary border border-os-border p-5 mb-10">
            <div className="flex items-center gap-4">
              <div className="p-2.5 bg-os-card border border-os-border">
                <Command size={20} className="text-os-text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm text-os-text-primary">
                  Press <kbd className="px-2.5 py-1 bg-os-card text-os-text-primary font-mono text-sm border border-os-border shadow-xs mx-1">{metaKey} K</kbd> to open the command palette
                </p>
              </div>
            </div>
          </div>

          {/* Main Actions */}
          <div className="space-y-3 mb-8">
            <ActionCard
              icon={Search}
              title="JQL Search"
              description="Build and save JQL queries with visual interface and templates"
              onClick={() => onNavigate('search')}
            />
            <ActionCard
              icon={FileText}
              title="Documents"
              description="Create and manage markdown documents with Jira conversion"
              onClick={() => onNavigate('documents')}
            />
            <ActionCard
              icon={Workflow}
              title="Workflow Builder"
              description="Design and execute automated workflows for repetitive tasks"
              onClick={() => onNavigate('workflow')}
            />
            <ActionCard
              icon={Activity}
              title="Diagnostics"
              description="Analyze sosreport and mustgather data with powerful parsers"
              onClick={() => onNavigate('diagnostics')}
            />
          </div>

          {/* Quick Notes Link */}
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('toggleDraftSidebar'));
            }}
            className="w-full bg-os-card border border-os-border hover:border-os-border hover:shadow-xs transition-all p-4 text-left"
          >
            <div className="flex items-center gap-3">
              <FileText size={18} className="text-os-text-secondary" />
              <span className="text-sm text-os-text-primary">Open Quick Notes</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
