import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Zap, Bug, CheckSquare, ShieldAlert, Lock, FileText, AlertCircle, Trash2, Star, Bookmark, Flag, Target, AlertTriangle } from 'lucide-react';
import { ListRow } from './common/sidebar/ListRow';
import { getTemplates, getCategories, deleteTemplate } from '../templates/jqlTemplates';
import ConfirmationModal from './common/modals/ConfirmationModal';
import { useConfirmation } from '../hooks/useConfirmation';

// Icon mapping for templates
const iconMap = {
  Bug,
  CheckSquare,
  ShieldAlert,
  Lock,
  FileText,
  AlertCircle,
  Zap,
  Star,
  Bookmark,
  Flag,
  Target,
  AlertTriangle,
};

export default function TemplateSidebar({ isOpen, onTemplateSelect, onRefresh }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [expandedCategories, setExpandedCategories] = useState([]);

  // Load templates on mount and when refreshed
  useEffect(() => {
    // mount-only async load
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTemplates() {
    const allTemplates = await getTemplates();
    const allCategories = await getCategories();
    setTemplates(allTemplates);
    setCategories(allCategories);

    // Expand first category by default if it exists
    if (allCategories.length > 0 && expandedCategories.length === 0) {
      setExpandedCategories([allCategories[0]]);
    }
  }

  function toggleCategory(category) {
    setExpandedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  }

  function handleTemplateClick(template) {
    onTemplateSelect(template);
  }

  async function handleDelete(templateId, e) {
    e.stopPropagation();
    if (await confirm({
      title: 'Delete Template',
      message: 'Are you sure you want to delete this template?',
      type: 'danger',
      confirmLabel: 'Delete',
    })) {
      await deleteTemplate(templateId);
      loadTemplates();
      if (onRefresh) onRefresh();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="w-72 bg-rh-black text-os-text-primary shrink-0 flex flex-col border-r-4 border-rh-red shadow-lg font-text">
      {/* Header */}
      <div className="p-4 border-b-2 border-os-border">
        <div className="flex items-center gap-2 mb-2">
          <Zap className="text-rh-red" size={24} />
          <h2 className="text-lg font-semibold">Quick Templates</h2>
        </div>
        <p className="text-xs text-os-text-secondary">
          Click any template to populate the builder
        </p>
      </div>

      {/* Template Categories */}
      <div className="py-2 flex-1 overflow-y-auto">
        {categories.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
            <Bookmark size={48} className="text-os-text-muted mb-3" />
            <h3 className="text-sm font-semibold text-os-text-primary mb-2">
              No templates yet
            </h3>
            <p className="text-xs text-os-text-muted">
              Build a query and save it as a template to get started
            </p>
          </div>
        ) : (
          categories.map(category => {
            const isExpanded = expandedCategories.includes(category);
            const categoryTemplates = templates.filter(t => t.category === category);

            return (
              <div key={category} className="mb-2">
                {/* Category Header */}
                <button
                  onClick={() => toggleCategory(category)}
                  className="w-full px-4 py-2 flex items-center justify-between hover:bg-os-card-secondary transition-colors text-left"
                >
                  <span className="font-display font-semibold text-sm text-os-text-primary">
                    {category} ({categoryTemplates.length})
                  </span>
                  {isExpanded ? (
                    <ChevronDown size={16} className="text-os-text-muted" />
                  ) : (
                    <ChevronRight size={16} className="text-os-text-muted" />
                  )}
                </button>

                {/* Templates */}
                {isExpanded && (
                  <div className="bg-os-card">
                    {categoryTemplates.map(template => {
                      const IconComponent = iconMap[template.icon];
                      return (
                        <div
                          key={template.id}
                          className="group relative hover:bg-rh-red/20 transition-colors border-l-4 border-transparent hover:border-rh-red"
                        >
                          <ListRow role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTemplateClick(template); } }}
                            onClick={() => handleTemplateClick(template)}
                            className="w-full px-6 py-3 text-left pr-12 cursor-pointer"
                          >
                            <div className="flex items-start gap-3">
                              {IconComponent && (
                                <IconComponent
                                  size={18}
                                  className="text-os-text-secondary group-hover:text-rh-red transition-colors shrink-0 mt-0.5"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm text-os-text-primary group-hover:text-rh-red transition-colors">
                                  {template.name}
                                </div>
                                {template.description && (
                                  <div className="text-xs text-os-text-secondary mt-1 line-clamp-2">
                                    {template.description}
                                  </div>
                                )}
                              </div>
                            </div>
                          </ListRow>
                          <button
                            onClick={(e) => handleDelete(template.id, e)}
                            className="absolute right-2 top-3 opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-600 rounded-sm transition-all"
                            title="Delete template"
                          >
                            <Trash2 size={14} className="text-os-text-primary" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {templates.length > 0 && (
        <div className="p-4 border-t-2 border-os-border">
          <p className="text-xs text-os-text-muted text-center">
            {templates.length} template{templates.length !== 1 ? 's' : ''} available
          </p>
        </div>
      )}

      {/* Confirmation Modal (replaces native confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}
