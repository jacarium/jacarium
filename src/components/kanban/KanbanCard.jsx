import { useState } from 'react';
import { MoreVertical, User, Calendar, AlertCircle } from 'lucide-react';
import InlineEdit from '../common/inputs/InlineEdit';
import DatePicker from '../common/inputs/DatePicker';
import { MenuItemIcon } from '../common/menus/MenuItemIcon';

const priorityColors = {
  low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  urgent: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
};

const priorityLabels = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
};

export default function KanbanCard({ card, onDelete, onDragStart, onRenameCard, onUpdateDescription, onUpdateCard, userInteractions = {}, connectedUsers = [], isReadOnly = false }) {
  const [showMenu, setShowMenu] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [descriptionValue, setDescriptionValue] = useState('');
  const [isEditingAssignee, setIsEditingAssignee] = useState(false);
  const [assigneeValue, setAssigneeValue] = useState('');
  const [showAssigneeSuggestions, setShowAssigneeSuggestions] = useState(false);
  const [isEditingDueDate, setIsEditingDueDate] = useState(false);
  const [dueDateValue, setDueDateValue] = useState('');
  const [isEditingPriority, setIsEditingPriority] = useState(false);
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [tagsValue, setTagsValue] = useState('');

  // Find users interacting with this card
  const interactingUsers = Object.entries(userInteractions)
    .filter(([, interaction]) => interaction.cardId === card.id)
    .map(([userId, interaction]) => ({
      userId,
      action: interaction.action,
      color: interaction.color
    }));

  function handleDragStart(e) {
    if (isReadOnly || isEditingTitle || isEditingDescription || isEditingAssignee || isEditingDueDate || isEditingPriority || isEditingTags) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    onDragStart();
  }

  function handleDragEnd() {
    // Reset any drag state if needed
  }

  function handleDoubleClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setIsEditingTitle(true);
  }

  function handleSaveTitle(newTitle) {
    if (newTitle.trim() && newTitle !== card.title) {
      onRenameCard?.(card.id, newTitle.trim());
    }
    setIsEditingTitle(false);
  }

  function handleDescriptionDoubleClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setDescriptionValue(card.description || '');
    setIsEditingDescription(true);
  }

  function handleSaveDescription() {
    if (descriptionValue !== card.description) {
      onUpdateDescription?.(card.id, descriptionValue.trim());
    }
    setIsEditingDescription(false);
  }

  function handleCancelDescription() {
    setIsEditingDescription(false);
    setDescriptionValue('');
  }

  function handleDescriptionKeyDown(e) {
    if (e.key === 'Escape') {
      handleCancelDescription();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      handleSaveDescription();
    }
  }

  function handleAssigneeClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setAssigneeValue(card.assignee || '');
    setIsEditingAssignee(true);
    setShowAssigneeSuggestions(false);
  }

  function handleAssigneeChange(e) {
    const value = e.target.value;
    setAssigneeValue(value);

    // Show suggestions if typing @ or if value starts with @
    if (value.startsWith('@') || value === '@') {
      setShowAssigneeSuggestions(true);
    } else {
      setShowAssigneeSuggestions(false);
    }
  }

  function handleSelectAssignee(username) {
    setAssigneeValue('@' + username);
    setShowAssigneeSuggestions(false);
    onUpdateCard?.(card.id, { assignee: '@' + username });
    setIsEditingAssignee(false);
  }

  function handleSaveAssignee() {
    if (assigneeValue !== card.assignee) {
      onUpdateCard?.(card.id, { assignee: assigneeValue.trim() });
    }
    setIsEditingAssignee(false);
    setShowAssigneeSuggestions(false);
  }

  function handleCancelAssignee() {
    setIsEditingAssignee(false);
    setAssigneeValue('');
    setShowAssigneeSuggestions(false);
  }

  function handleAssigneeKeyDown(e) {
    if (e.key === 'Escape') {
      handleCancelAssignee();
    } else if (e.key === 'Enter') {
      handleSaveAssignee();
    }
  }

  // Filter connected users based on input
  const filteredUsers = connectedUsers.filter(username => {
    if (!assigneeValue || assigneeValue === '@') return true;
    const searchTerm = assigneeValue.startsWith('@') ? assigneeValue.substring(1).toLowerCase() : assigneeValue.toLowerCase();
    return username.toLowerCase().includes(searchTerm);
  });

  function handleDueDateClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setDueDateValue(card.dueDate || '');
    setIsEditingDueDate(true);
  }

  function handlePriorityClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setIsEditingPriority(true);
  }

  function handlePrioritySelect(priority) {
    if (priority !== card.priority) {
      onUpdateCard?.(card.id, { priority });
    }
    setIsEditingPriority(false);
  }

  function handleTagsClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setTagsValue((card.tags || []).join(', '));
    setIsEditingTags(true);
  }

  function handleSaveTags() {
    const newTags = tagsValue
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);

    if (JSON.stringify(newTags) !== JSON.stringify(card.tags || [])) {
      onUpdateCard?.(card.id, { tags: newTags });
    }
    setIsEditingTags(false);
  }

  function handleCancelTags() {
    setIsEditingTags(false);
    setTagsValue('');
  }

  function handleTagsKeyDown(e) {
    if (e.key === 'Escape') {
      handleCancelTags();
    } else if (e.key === 'Enter') {
      handleSaveTags();
    }
  }

  // Determine border style based on user interactions
  const hasInteractions = interactingUsers.length > 0;
  const primaryInteraction = interactingUsers[0];
  const borderStyle = hasInteractions
    ? {
        borderColor: primaryInteraction.color,
        borderWidth: '2px',
        boxShadow: `0 0 0 2px ${primaryInteraction.color}33`
      }
    : {};

  return (
    <div
      draggable={!isReadOnly && !isEditingTitle && !isEditingDescription && !isEditingAssignee && !isEditingDueDate && !isEditingPriority && !isEditingTags}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={`sc-kanban-card bg-os-card rounded-lg p-3 shadow-xs border border-os-border hover:shadow-md transition-all group relative ${!isReadOnly ?'cursor-grab active:cursor-grabbing':''}`}
      style={borderStyle}
    >
      {/* User Interaction Indicators */}
      {hasInteractions && (
        <div className="absolute -top-2 -right-2 z-10 flex gap-1">
          {interactingUsers.map((user) => (
            <div
              key={user.userId}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium shadow-xs"
              style={{
                backgroundColor: user.color,
                color: '#fff'
              }}
              title={`${user.userId} is ${user.action}`}
            >
              <div
                className="w-2 h-2 rounded-full bg-os-card animate-pulse"
              />
              <span className="max-w-[80px] truncate">{user.userId}</span>
            </div>
          ))}
        </div>
      )}
      {/* Card Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        {isEditingTitle ? (
          <InlineEdit
            value={card.title}
            onSave={handleSaveTitle}
            onCancel={() => setIsEditingTitle(false)}
            isEditing={true}
            onEditingChange={(editing) => {
              if (!editing) {
                setIsEditingTitle(false);
              }
            }}
            className="flex-1"
            inputClassName="text-sm font-medium"
          />
        ) : (
          <h4
            className={`sc-kanban-card-title text-sm font-medium text-os-text-primary flex-1 line-clamp-2 transition-colors ${!isReadOnly ?'cursor-pointer hover:text-os-blue':''}`}
            onDoubleClick={handleDoubleClick}
            title={!isReadOnly ? "Double-click to rename" : ""}
          >
            {card.title}
          </h4>
        )}
        {!isReadOnly && (
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-1 opacity-0 group-hover:opacity-100 hover:bg-os-card-secondary rounded-sm transition-opacity"
            >
              <MoreVertical size={14} className="text-os-text-secondary" />
            </button>

          {/* Context Menu */}
          {showMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowMenu(false)}
              />
              <div className="absolute right-0 top-6 z-20 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[120px]">
                <button
                  onClick={() => {
                    onDelete();
                    setShowMenu(false);
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
                >
                  <MenuItemIcon action="delete" danger />
                  Delete
                </button>
              </div>
            </>
          )}
          </div>
        )}
      </div>

      {/* Description */}
      {isEditingDescription ? (
        <div className="mb-3">
          <textarea
            value={descriptionValue}
            onChange={(e) => setDescriptionValue(e.target.value)}
            onKeyDown={handleDescriptionKeyDown}
            onBlur={handleSaveDescription}
            autoFocus
            className="w-full px-2 py-1.5 text-xs border border-os-blue rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden resize-none bg-os-input-bg text-os-text-primary h-32 overflow-y-auto"
            placeholder="Add description... (Ctrl+Enter to save, Esc to cancel)"
          />
        </div>
      ) : (
        <>
          {card.description ? (
            <div
              className="mb-3 max-h-32 overflow-y-auto cursor-pointer hover:bg-os-card-secondary/50 transition-colors rounded-sm px-1 -mx-1"
              onDoubleClick={handleDescriptionDoubleClick}
              title="Double-click to edit"
            >
              <p className="text-xs text-os-text-muted whitespace-pre-wrap">
                {card.description}
              </p>
            </div>
          ) : (
            <p
              className="text-xs text-os-text-muted mb-3 italic opacity-60 cursor-pointer hover:text-os-blue transition-colors"
              onDoubleClick={handleDescriptionDoubleClick}
              title="Double-click to add description"
            >
              Add description...
            </p>
          )}
        </>
      )}

      {/* Tags */}
      {isEditingTags ? (
        <div className="mb-3">
          <input
            type="text"
            value={tagsValue}
            onChange={(e) => setTagsValue(e.target.value)}
            onKeyDown={handleTagsKeyDown}
            onBlur={handleSaveTags}
            autoFocus
            className="w-full px-2 py-1.5 text-xs border border-os-blue rounded-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-hidden bg-os-input-bg text-os-text-primary"
            placeholder="Add tags (comma-separated)..."
          />
        </div>
      ) : card.tags && card.tags.length > 0 ? (
        <div
          className={`flex flex-wrap gap-1 mb-3 ${!isReadOnly ?'cursor-pointer hover:opacity-80':''}`}
          onClick={handleTagsClick}
          title={!isReadOnly ? "Click to edit tags" : ""}
        >
          {card.tags.map((tag, index) => (
            <span
              key={index}
              className="px-2 py-0.5 text-xs bg-os-card-secondary text-os-text-secondary rounded-sm"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : !isReadOnly ? (
        <div
          className="mb-3 px-2 py-1 text-xs text-os-text-muted hover:text-os-blue cursor-pointer italic opacity-60"
          onClick={handleTagsClick}
          title="Click to add tags"
        >
          Add tags...
        </div>
      ) : null}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-os-text-muted mt-3 pt-3 border-t border-os-border">
        <div className="flex items-center gap-3">
          {/* Priority */}
          {isEditingPriority ? (
            <div className="relative">
              <div className="fixed inset-0 z-10" onClick={() => setIsEditingPriority(false)} />
              <div className="absolute bottom-0 left-0 z-20 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[100px]">
                {Object.entries(priorityLabels).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => handlePrioritySelect(key)}
                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2 ${priorityColors[key]}`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={() => handlePrioritySelect(null)}
                  className="w-full px-3 py-1.5 text-left text-xs text-os-text-muted hover:bg-os-card-secondary"
                >
                  Clear
                </button>
              </div>
            </div>
          ) : card.priority ? (
            <span
              className={`px-2 py-0.5 rounded-sm flex items-center gap-1 ${priorityColors[card.priority]} ${!isReadOnly ?'cursor-pointer hover:opacity-80':''}`}
              onClick={handlePriorityClick}
            >
              <AlertCircle size={12} />
              {priorityLabels[card.priority]}
            </span>
          ) : !isReadOnly && (
            <span
              className="px-2 py-0.5 rounded-sm flex items-center gap-1 text-os-text-muted hover:bg-os-card-secondary cursor-pointer"
              onClick={handlePriorityClick}
            >
              <AlertCircle size={12} />
              Set priority
            </span>
          )}

          {/* Assignee */}
          {isEditingAssignee ? (
            <div className="relative">
              <input
                type="text"
                value={assigneeValue}
                onChange={handleAssigneeChange}
                onKeyDown={handleAssigneeKeyDown}
                onBlur={() => {
                  // Delay to allow clicking on suggestions
                  setTimeout(() => handleSaveAssignee(), 150);
                }}
                autoFocus
                className="px-2 py-0.5 text-xs border border-os-blue rounded-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-hidden w-32 bg-os-input-bg text-os-text-primary"
                placeholder="@username or name"
              />
              {showAssigneeSuggestions && connectedUsers.length > 0 && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowAssigneeSuggestions(false)}
                  />
                  <div className="absolute bottom-full left-0 mb-1 z-20 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[150px] max-h-[200px] overflow-y-auto">
                    {filteredUsers.length > 0 ? (
                      filteredUsers.map((username) => (
                        <button
                          key={username}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleSelectAssignee(username);
                          }}
                          className="w-full px-3 py-1.5 text-left text-xs text-os-text-primary hover:bg-blue-50 flex items-center gap-2"
                        >
                          <User size={12} />
                          @{username}
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-1.5 text-xs text-os-text-muted">
                        No connected users
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : card.assignee ? (
            <div
              className={`flex items-center gap-1 ${!isReadOnly ?'cursor-pointer hover:text-os-blue':''}`}
              onClick={handleAssigneeClick}
              title={!isReadOnly ? "Click to edit assignee" : ""}
            >
              <User size={12} />
              <span>{card.assignee}</span>
            </div>
          ) : !isReadOnly && (
            <div
              className="flex items-center gap-1 text-os-text-muted hover:text-os-blue cursor-pointer italic opacity-60"
              onClick={handleAssigneeClick}
              title="Click to set assignee"
            >
              <User size={12} />
              <span>Add assignee</span>
            </div>
          )}
        </div>

        {/* Due Date */}
        {isEditingDueDate ? (
          <DatePicker
            value={dueDateValue}
            onChange={(newDate) => {
              setDueDateValue(newDate);
              onUpdateCard?.(card.id, { dueDate: newDate });
              setIsEditingDueDate(false);
            }}
            className="px-2 py-0.5 text-xs text-os-text-primary"
          />
        ) : card.dueDate ? (
          <div
            className={`flex items-center gap-1 ${!isReadOnly ?'cursor-pointer hover:text-os-blue':''}`}
            onClick={handleDueDateClick}
          >
            <Calendar size={12} />
            <span>{new Date(card.dueDate).toLocaleDateString()}</span>
          </div>
        ) : !isReadOnly && (
          <div
            className="flex items-center gap-1 text-os-text-muted hover:text-os-blue cursor-pointer italic opacity-60"
            onClick={handleDueDateClick}
          >
            <Calendar size={12} />
            <span>Add date</span>
          </div>
        )}
      </div>
    </div>
  );
}
