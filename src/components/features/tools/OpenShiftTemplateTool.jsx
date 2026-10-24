import { useState, useRef, useEffect } from 'react';
import { Copy, Download, Save, X, Search, Plus, Edit, FileCode, Bug, CheckSquare, ShieldAlert, Lock, FileText, AlertCircle, Zap, Star, Bookmark, Flag, Target, AlertTriangle, Check } from 'lucide-react';
import { useNotifications } from '../../../contexts/NotificationContext';
import InlineEdit from '../../common/inputs/InlineEdit';
import ConfirmationModal from '../../common/ConfirmationModal';
import {
  getOpenshiftTemplates,
  createOpenshiftTemplate,
  updateOpenshiftTemplate,
  deleteOpenshiftTemplate
} from '../../../utils/openshiftTemplates';
import { EmptyState, Button } from '../../ui';
import { MenuItemIcon } from '../../common/menus/MenuItemIcon';

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
  FileCode,
};

const availableIcons = [
  'FileCode',
  'Bug',
  'CheckSquare',
  'ShieldAlert',
  'Lock',
  'FileText',
  'AlertCircle',
  'Zap',
  'Star',
  'Bookmark',
  'Flag',
  'Target',
  'AlertTriangle',
];

/**
 * OpenShift Template Tool
 * Professional YAML template manager for OpenShift/Kubernetes
 */
export default function OpenShiftTemplateTool() {
  const { addNotification } = useNotifications();
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [generatedYaml, setGeneratedYaml] = useState('');
  const [templates, setTemplates] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState([]);
  const [draggedTemplate, setDraggedTemplate] = useState(null);
  const [dragOverCategory, setDragOverCategory] = useState(null);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [showCopied, setShowCopied] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState(null);

  // Context menu
  const [contextMenu, setContextMenu] = useState({ visible: false, x: 0, y: 0, template: null });
  const contextMenuRef = useRef(null);

  // Form fields for save/edit modal
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateCategory, setTemplateCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [templateIcon, setTemplateIcon] = useState('FileCode');
  const [editingTemplate, setEditingTemplate] = useState(null);

  const textareaRef = useRef(null);

  const loadTemplates = async () => {
    const loaded = await getOpenshiftTemplates();
    setTemplates(loaded);

    // Auto-expand all categories
    const categories = [...new Set(loaded.map(t => t.category))];
    setExpandedCategories(categories);
  };

  // Load templates on mount
  useEffect(() => {
    // async loader; all setState happens after the await
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTemplates();
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target)) {
        setContextMenu({ visible: false, x: 0, y: 0, template: null });
      }
    }
    if (contextMenu.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu.visible]);

  // Get unique categories
  const categories = [...new Set(templates.map(t => t.category))].sort();

  // Filter templates based on search
  const filteredTemplates = templates.filter(t =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (t.description && t.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
    t.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group templates by category
  const groupedTemplates = filteredTemplates.reduce((acc, template) => {
    if (!acc[template.category]) {
      acc[template.category] = [];
    }
    acc[template.category].push(template);
    return acc;
  }, {});

  const handleSelectTemplate = (template) => {
    if (editingTemplateId === template.id) return; // Don't select while editing
    setSelectedTemplate(template);
    setGeneratedYaml(template.yaml);
  };

  const handleRenameTemplate = async (templateId, newName) => {
    if (!newName.trim()) {
      setEditingTemplateId(null);
      return;
    }

    try {
      await updateOpenshiftTemplate(templateId, {
        name: newName.trim()
      });

      await loadTemplates();

      // Update selected template if it's the one being renamed
      if (selectedTemplate?.id === templateId) {
        const updated = await getOpenshiftTemplates().then(all => all.find(t => t.id === templateId));
        if (updated) {
          setSelectedTemplate(updated);
        }
      }

      setEditingTemplateId(null);
    } catch {
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to rename template'
      });
      setEditingTemplateId(null);
    }
  };

  const handleNewTemplate = async () => {
    try {
      // Create a new template in the database
      const id = await createOpenshiftTemplate({
        name: 'Untitled Template',
        description: '',
        category: 'General',
        yaml: '',
        icon: 'FileCode',
      });

      await loadTemplates();

      // Select the newly created template
      const newTemplate = templates.find(t => t.id === id) || await getOpenshiftTemplates().then(all => all.find(t => t.id === id));
      if (newTemplate) {
        setSelectedTemplate(newTemplate);
        setGeneratedYaml('');
      }

      addNotification({
        type: 'success',
        title: 'Created',
        message: 'New template created'
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to create template'
      });
    }
  };

  const handleCopy = () => {
    if (!generatedYaml) return;
    navigator.clipboard.writeText(generatedYaml);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!generatedYaml) return;

    const filename = selectedTemplate?.name
      ? `${selectedTemplate.name.toLowerCase().replace(/\s+/g, '-')}.yaml`
      : 'template.yaml';

    const blob = new Blob([generatedYaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addNotification({
      type: 'success',
      title: 'Downloaded',
      message: `${filename} downloaded`
    });
  };

  const handleSave = async () => {
    if (!selectedTemplate) return;

    try {
      // Update the template's YAML content
      await updateOpenshiftTemplate(selectedTemplate.id, {
        yaml: generatedYaml
      });

      await loadTemplates();

      addNotification({
        type: 'success',
        title: 'Saved',
        message: 'Template saved successfully'
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to save template'
      });
    }
  };

  const handleEdit = () => {
    if (!contextMenu.template) return;

    setEditingTemplate(contextMenu.template);
    setTemplateName(contextMenu.template.name);
    setTemplateDescription(contextMenu.template.description || '');
    setTemplateCategory(contextMenu.template.category);
    setTemplateIcon(contextMenu.template.icon || 'FileCode');
    setShowEditModal(true);
    setContextMenu({ visible: false, x: 0, y: 0, template: null });
  };

  const handleSaveEdit = async () => {
    const trimmedName = templateName.trim();
    const trimmedDescription = templateDescription.trim();
    const finalCategory = showNewCategory ? newCategory.trim() : templateCategory;

    if (!trimmedName) {
      addNotification({
        type: 'error',
        title: 'Name Required',
        message: 'Please enter a template name'
      });
      return;
    }

    if (!finalCategory) {
      addNotification({
        type: 'error',
        title: 'Category Required',
        message: 'Please select or create a category'
      });
      return;
    }

    try {
      await updateOpenshiftTemplate(editingTemplate.id, {
        name: trimmedName,
        description: trimmedDescription,
        category: finalCategory,
        icon: templateIcon,
      });

      await loadTemplates();

      // Update selected template if it's the one being edited
      if (selectedTemplate?.id === editingTemplate.id) {
        const updated = await getOpenshiftTemplates().then(all => all.find(t => t.id === editingTemplate.id));
        if (updated) {
          setSelectedTemplate(updated);
        }
      }

      setShowEditModal(false);
      resetForm();

      addNotification({
        type: 'success',
        title: 'Updated',
        message: `Template "${trimmedName}" updated successfully`
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to update template'
      });
    }
  };

  const resetForm = () => {
    setTemplateName('');
    setTemplateDescription('');
    setTemplateCategory('');
    setNewCategory('');
    setShowNewCategory(false);
    setTemplateIcon('FileCode');
    setEditingTemplate(null);
  };

  const handleDelete = () => {
    if (!contextMenu.template) return;
    setTemplateToDelete(contextMenu.template);
    setShowDeleteModal(true);
    setContextMenu({ visible: false, x: 0, y: 0, template: null });
  };

  const confirmDelete = async () => {
    if (!templateToDelete) return;

    try {
      await deleteOpenshiftTemplate(templateToDelete.id);
      await loadTemplates();

      // Clear selected if it was deleted
      if (selectedTemplate?.id === templateToDelete.id) {
        setSelectedTemplate(null);
        setGeneratedYaml('');
      }

      addNotification({
        type: 'success',
        title: 'Deleted',
        message: 'Template deleted'
      });
    } catch {
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to delete template'
      });
    } finally {
      setShowDeleteModal(false);
      setTemplateToDelete(null);
    }
  };

  const toggleCategory = (category) => {
    setExpandedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  };

  const handleContextMenu = (e, template) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      template
    });
  };

  // Drag and drop handlers
  const handleDragStart = (template, e) => {
    setDraggedTemplate(template);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', template.id);
  };

  const handleDragEnd = () => {
    setDraggedTemplate(null);
    setDragOverCategory(null);
  };

  const handleDragOver = (categoryName, e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCategory(categoryName);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragOverCategory(null);
  };

  const handleDrop = async (categoryName, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverCategory(null);

    if (!draggedTemplate || draggedTemplate.category === categoryName) {
      setDraggedTemplate(null);
      return;
    }

    try {
      await updateOpenshiftTemplate(draggedTemplate.id, {
        category: categoryName
      });

      await loadTemplates();

      // Update selected template if it's the one being moved
      if (selectedTemplate?.id === draggedTemplate.id) {
        const updated = await getOpenshiftTemplates().then(all => all.find(t => t.id === draggedTemplate.id));
        if (updated) {
          setSelectedTemplate(updated);
        }
      }
    } catch (error) {
      console.error('Failed to move template:', error);
      addNotification({
        type: 'error',
        title: 'Error',
        message: 'Failed to move template'
      });
    } finally {
      setDraggedTemplate(null);
    }
  };

  return (
    <div className="flex h-full">
      {/* Sidebar - Template List */}
      <div className="w-80 border-r border-os-border flex flex-col">
        {/* Header */}
        <div className="p-3 border-b border-os-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-os-text-primary uppercase tracking-wide">
              Templates
            </h3>
            <button
              onClick={handleNewTemplate}
              className="p-1.5 rounded-sm transition-colors hover:bg-os-card-secondary"
              title="Add new template"
            >
              <Plus size={16} className="text-os-text-secondary" />
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-os-text-secondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search templates..."
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-os-border rounded-sm bg-os-card text-os-text-primary placeholder:text-os-text-muted"
            />
          </div>
        </div>

        {/* Template List */}
        <div className="flex-1 overflow-y-auto">
          {templates.length === 0 ? (
            <EmptyState compact icon={FileCode} title="No templates yet" description="Create your first template" />
          ) : (
            Object.entries(groupedTemplates).map(([category, categoryTemplates]) => (
              <div key={category}>
                {/* Category Header */}
                <div
                  onDragOver={(e) => handleDragOver(category, e)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(category, e)}
                  className={`px-2 py-2 transition-colors ${
 dragOverCategory === category ?'bg-os-blue/20':'hover:bg-os-card-secondary'
 }`}
                >
                  <div className="flex items-center gap-2">
                    {/* Expand/Collapse Chevron */}
                    <button
                      onClick={() => toggleCategory(category)}
                      className="p-0.5 hover:bg-os-card-secondary rounded-sm transition-colors"
                      title={expandedCategories.includes(category) ? 'Collapse' : 'Expand'}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`text-os-text-muted transition-transform ${
 expandedCategories.includes(category) ?'rotate-90':''
 }`}
                      >
                        <polyline points="9 18 15 12 9 6"></polyline>
                      </svg>
                    </button>

                    {/* Category Name and Count */}
                    <button
                      onClick={() => toggleCategory(category)}
                      className="flex-1 flex items-center justify-between text-left"
                    >
                      <span className="text-sm font-semibold text-os-text-muted">
                        {category}
                      </span>
                      <span className="text-sm text-os-text-muted font-medium">
                        {categoryTemplates.length}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Template Items */}
                {expandedCategories.includes(category) && (
                  <div>
                    {categoryTemplates.map((template) => {
                      const IconComponent = iconMap[template.icon] || FileCode;
                      const isSelected = selectedTemplate?.id === template.id;
                      const isEditing = editingTemplateId === template.id;

                      return (
                        <div
                          key={template.id}
                          draggable={!isEditing}
                          onDragStart={(e) => handleDragStart(template, e)}
                          onDragEnd={handleDragEnd}
                          onContextMenu={(e) => handleContextMenu(e, template)}
                          onClick={() => handleSelectTemplate(template)}
                          onDoubleClick={() => setEditingTemplateId(template.id)}
                          className={`group relative px-4 py-3 cursor-pointer transition-colors border-l-4 ${
 isSelected
 ?'bg-blue-50 border-os-blue'
 :'hover:bg-os-card-secondary border-transparent'
 }`}
                        >
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <IconComponent size={14} className="text-os-text-muted shrink-0" />
                              <InlineEdit
                                value={template.name}
                                onSave={(newName) => handleRenameTemplate(template.id, newName)}
                                onCancel={() => setEditingTemplateId(null)}
                                isEditing={true}
                                onEditingChange={(editing) => {
                                  if (!editing) {
                                    setEditingTemplateId(null);
                                  }
                                }}
                                className="flex-1"
                                inputClassName="text-sm"
                              />
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <IconComponent
                                size={14}
                                className={`shrink-0 ${
 isSelected ?'text-os-blue':'text-os-text-muted'
 }`}
                              />
                              <div className="flex-1 min-w-0">
                                <span className={`text-sm truncate block ${
 isSelected ?'text-os-blue':'text-os-text-primary'
 }`}>
                                  {template.name}
                                </span>
                                {template.description && (
                                  <span className="text-xs text-os-text-secondary block truncate mt-0.5">
                                    {template.description}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Content - YAML Editor */}
      <div className="flex-1 flex flex-col">
        {!selectedTemplate ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState icon={FileCode} title="Select a template to edit" description="Create a new template or select one from the list" action={<Button variant="primary" size="lg" onClick={handleNewTemplate}>New Template</Button>} />
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b border-os-border flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-os-text-primary">
                  {selectedTemplate.name}
                </h2>
                {selectedTemplate.description && (
                  <p className="text-sm text-os-text-secondary mt-0.5">
                    {selectedTemplate.description}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCopy}
                  disabled={!generatedYaml}
                  className="px-3 py-1.5 flex items-center gap-2 border border-os-border rounded-sm hover:bg-os-card-secondary disabled:opacity-50 disabled:cursor-not-allowed text-os-text-primary text-sm transition-all"
                  title="Copy to clipboard"
                >
                  {showCopied ? (
                    <>
                      <Check size={16} className="text-green-600" />
                      <span className="text-green-600">Copied</span>
                    </>
                  ) : (
                    <>
                      Copy
                    </>
                  )}
                </button>
                <button
                  onClick={handleDownload}
                  disabled={!generatedYaml}
                  className="px-3 py-1.5 flex items-center gap-2 border border-os-border rounded-sm hover:bg-os-card-secondary disabled:opacity-50 disabled:cursor-not-allowed text-os-text-primary text-sm"
                  title="Download YAML file"
                >
                  Download
                </button>
                <button
                  onClick={handleSave}
                  disabled={!selectedTemplate}
                  className="btn btn-primary px-3 py-1.5 flex items-center gap-2 text-sm"
                  title="Save template"
                >
                  Save
                </button>
              </div>
            </div>

            {/* YAML Editor */}
            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={generatedYaml}
                onChange={(e) => setGeneratedYaml(e.target.value)}
                className="w-full h-full font-mono text-sm border-0 p-4 bg-os-card text-os-text-primary resize-none focus:outline-hidden"
                placeholder="Enter your YAML template here..."
                spellCheck={false}
              />
            </div>
          </>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && contextMenu.template && (
        <div
          ref={contextMenuRef}
          className="sc-context-menu fixed bg-os-modal border border-os-border shadow-lg rounded-lg z-50 py-1.5 min-w-[180px]"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button
            onClick={handleEdit}
            className="w-full px-4 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="edit" />
            Edit
          </button>
          <div className="border-t border-os-border my-1"></div>
          <button
            onClick={handleDelete}
            className="w-full px-4 py-2 text-left text-sm text-(--btn-danger-fg) hover:bg-(--btn-danger-bg-hover) flex items-center gap-2"
          >
            <MenuItemIcon action="delete" danger />
            Delete
          </button>
        </div>
      )}

      {/* Edit Template Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-os-modal shadow-lg max-w-lg w-full border border-os-border rounded-sm max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="p-4 border-b border-os-border bg-os-modal flex items-center justify-between sticky top-0 z-10">
              <h2 className="text-sm font-semibold text-os-text-primary uppercase tracking-wide">
                Edit Template
              </h2>
              <button
                onClick={() => {
                  setShowEditModal(false);
                  resetForm();
                }}
                className="p-1 hover:bg-os-sidebar-hover rounded-sm transition-colors"
              >
                <X size={20} className="text-os-text-secondary" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6 space-y-4 bg-os-modal">
              {/* Template Name */}
              <div>
                <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
                  Template Name *
                </label>
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="e.g., Debug Pod, Storage Test"
                  className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                  autoFocus
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
                  Description
                </label>
                <textarea
                  value={templateDescription}
                  onChange={(e) => setTemplateDescription(e.target.value)}
                  placeholder="Brief description of what this template does"
                  className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden resize-none text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                  rows="3"
                />
              </div>

              {/* Category Selection */}
              <div>
                <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
                  Category *
                </label>
                {!showNewCategory ? (
                  <div className="flex gap-2">
                    <select
                      value={templateCategory}
                      onChange={(e) => setTemplateCategory(e.target.value)}
                      className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary"
                    >
                      <option value="">Select category...</option>
                      {categories.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => setShowNewCategory(true)}
                      className="btn btn-primary flex items-center gap-2 px-3 py-2 text-sm"
                      title="Create new category"
                    >
                      New
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                      placeholder="Enter new category name"
                      className="flex-1 px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm bg-os-modal text-os-text-primary placeholder:text-os-text-muted"
                    />
                    <button
                      onClick={() => {
                        setShowNewCategory(false);
                        setNewCategory('');
                      }}
                      className="px-3 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              {/* Icon Selection */}
              <div>
                <label className="block text-xs text-os-text-primary mb-2 uppercase tracking-wide">
                  Icon
                </label>
                <div className="grid grid-cols-6 gap-2">
                  {availableIcons.map(iconName => {
                    const IconComponent = iconMap[iconName];
                    return (
                      <button
                        key={iconName}
                        onClick={() => setTemplateIcon(iconName)}
                        className={`p-3 border transition-all bg-os-modal flex items-center justify-center ${
 templateIcon === iconName
 ?'btn-selected-soft'
 :'border-os-input-border hover:border-os-blue hover:bg-os-card-secondary'
 }`}
                        title={iconName}
                      >
                        {IconComponent && (
                          <IconComponent
                            size={20}
                            className={templateIcon === iconName ?'text-os-blue':'text-os-text-muted'}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-os-border bg-os-modal flex items-center justify-end gap-3 sticky bottom-0">
              <button
                onClick={() => {
                  setShowEditModal(false);
                  resetForm();
                }}
                className="px-4 py-2 bg-os-modal border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                className="btn btn-primary flex items-center gap-2 px-4 py-2 text-sm"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setTemplateToDelete(null);
        }}
        onConfirm={confirmDelete}
        title="Delete Template"
        message={`Are you sure you want to delete "${templateToDelete?.name}"?\n\nThis action cannot be undone.`}
        confirmText="Delete"
        dangerous={true}
      />
    </div>
  );
}
