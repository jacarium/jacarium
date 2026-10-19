import { useState } from 'react';
import { CheckCircle, Circle, Trash2, FolderOpen, Tag, Calendar, AlertCircle, Cloud, Square, MessageSquare, Repeat, TrendingUp, Check, Clock } from 'lucide-react';
import InlineEdit from '../common/inputs/InlineEdit';
import DatePicker from '../common/inputs/DatePicker';
import TaskTimer from './TaskTimer';

const priorityColors = {
  L: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  M: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  H: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
};

const priorityLabels = {
  L: 'Low',
  M: 'Medium',
  H: 'High'
};

export default function TaskItem({ task, onUpdate, onDelete, onToggleComplete, onStart, onStop, onAnnotate, onDenotate, projects = [], isReadOnly = false, isSelected = false, onToggleSelection, onContextMenu }) {
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [projectValue, setProjectValue] = useState('');
  const [showProjectSuggestions, setShowProjectSuggestions] = useState(false);
  const [isEditingPriority, setIsEditingPriority] = useState(false);
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [tagsValue, setTagsValue] = useState('');
  const [isEditingDueDate, setIsEditingDueDate] = useState(false);
  const [isEditingWaitDate, setIsEditingWaitDate] = useState(false);
  const [isEditingRecur, setIsEditingRecur] = useState(false);
  const [newAnnotation, setNewAnnotation] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);

  function handleSaveDescription(newDescription) {
    if (newDescription.trim() && newDescription !== task.description) {
      onUpdate?.(task.id, { description: newDescription.trim() });
    }
    setIsEditingDescription(false);
  }

  function handleProjectClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setProjectValue(task.project || '');
    setIsEditingProject(true);
    setShowProjectSuggestions(false);
  }

  function handleProjectChange(e) {
    const value = e.target.value;
    setProjectValue(value);
    setShowProjectSuggestions(value.length > 0 && projects.length > 0);
  }

  function handleSelectProject(projectName) {
    setProjectValue(projectName);
    setShowProjectSuggestions(false);
    onUpdate?.(task.id, { project: projectName });
    setIsEditingProject(false);
  }

  function handleSaveProject() {
    if (projectValue !== task.project) {
      onUpdate?.(task.id, { project: projectValue.trim() });
    }
    setIsEditingProject(false);
    setShowProjectSuggestions(false);
  }

  function handleCancelProject() {
    setIsEditingProject(false);
    setProjectValue('');
    setShowProjectSuggestions(false);
  }

  function handleProjectKeyDown(e) {
    if (e.key === 'Escape') {
      handleCancelProject();
    } else if (e.key === 'Enter') {
      handleSaveProject();
    }
  }

  // Filter projects based on input
  const filteredProjects = projects.filter(p => {
    if (!projectValue) return true;
    return p.toLowerCase().includes(projectValue.toLowerCase());
  });

  function handlePriorityClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setIsEditingPriority(true);
  }

  function handlePrioritySelect(priority) {
    if (priority !== task.priority) {
      onUpdate?.(task.id, { priority });
    }
    setIsEditingPriority(false);
  }

  function handleTagsClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setTagsValue((task.tags || []).join(', '));
    setIsEditingTags(true);
  }

  function handleSaveTags() {
    const newTags = tagsValue
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);

    if (JSON.stringify(newTags) !== JSON.stringify(task.tags || [])) {
      onUpdate?.(task.id, { tags: newTags });
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

  function handleDueDateClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setIsEditingDueDate(true);
  }

  function handleWaitDateClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setIsEditingWaitDate(true);
  }

  function handleStartTask() {
    if (isReadOnly) return;
    onStart?.(task);
  }

  function handleStopTask() {
    if (isReadOnly) return;
    onStop?.(task);
  }

  function handleAddAnnotation() {
    if (!newAnnotation.trim() || isReadOnly) return;
    onAnnotate?.(task, newAnnotation.trim());
    setNewAnnotation('');
  }

  function handleRecurClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setIsEditingRecur(true);
  }

  function handleRecurSelect(recurrence) {
    if (recurrence !== task.recur) {
      onUpdate?.(task.id, { recur: recurrence || null });
    }
    setIsEditingRecur(false);
  }

  const isCompleted = task.status === 'completed';
  const isActive = !!task.start;

  // Calculate task age
  const getTaskAge = () => {
    if (!task.entry) return null;
    try {
      const entryDate = new Date(task.entry);
      const now = new Date();

      // Check if date is valid
      if (isNaN(entryDate.getTime())) {
        return null;
      }

      const diffMs = now - entryDate;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      // Check for negative or invalid values
      if (diffDays < 0 || isNaN(diffDays)) {
        return null;
      }

      if (diffDays === 0) return 'today';
      if (diffDays === 1) return '1d';
      if (diffDays < 7) return `${diffDays}d`;
      if (diffDays < 30) {
        const weeks = Math.floor(diffDays / 7);
        return `${weeks}w`;
      }
      if (diffDays < 365) {
        const months = Math.floor(diffDays / 30);
        return `${months}mo`;
      }
      const years = Math.floor(diffDays / 365);
      return `${years}y`;
    } catch {
      return null;
    }
  };

  const taskAge = getTaskAge();

  return (
    <div
      data-testid="task-item"
      onClick={(e) => {
        // Allow selection by clicking on card background when holding ctrl/cmd
        if ((e.ctrlKey || e.metaKey) && onToggleSelection && !isReadOnly) {
          e.stopPropagation();
          onToggleSelection();
        }
      }}
      onContextMenu={onContextMenu ? (e) => {
        // Text fields keep the native menu (copy/paste/spell-check): the
        // inline editors for description/project/tags/notes live inside the row.
        if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        onContextMenu(e, task);
      } : undefined}
      className={`sc-task-card ${isActive ? 'sc-task-card-active' : ''} bg-os-card rounded-md border transition-all group relative hover:border-os-border-hover ${
 isSelected
 ?'border-os-blue/60 bg-blue-50/30 dark:bg-blue-500/5 shadow-xs'
 : isCompleted
 ?'border-os-border'
 : isActive
 ?'border-green-500/30 bg-green-50/30 dark:bg-green-500/5'
 :'border-os-border'
 }`}
    >
      <div className="flex items-start gap-2.5 px-4 py-2.5">
        {/* Complete Checkbox */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            !isReadOnly && onToggleComplete?.(task);
          }}
          className="mt-0.5 shrink-0"
          disabled={isReadOnly}
          title={isCompleted ? 'Mark as not done' : 'Mark as done'}
          aria-label={isCompleted ? 'Mark as not done' : 'Mark as done'}
          aria-pressed={isCompleted}
          data-testid="task-done-toggle"
        >
          {isCompleted ? (
            <CheckCircle className="w-4 h-4 text-green-500" />
          ) : (
            <Circle className={`w-4 h-4 text-os-text-muted ${!isReadOnly ? 'hover:text-os-blue transition-colors' : ''}`} />
          )}
        </button>

        {/* Task content */}
        <div className="flex-1 min-w-0">
          {/* Description */}
          {isEditingDescription ? (
            <InlineEdit
              value={task.description}
              onSave={handleSaveDescription}
              onCancel={() => setIsEditingDescription(false)}
              isEditing={true}
              onEditingChange={(editing) => {
                if (!editing) {
                  setIsEditingDescription(false);
                }
              }}
              className="flex-1 mb-6"
              inputClassName="text-sm"
            />
          ) : (
            <div className="flex items-center gap-1.5 mb-4">
              <p
                className={`sc-task-title text-sm ${
 isCompleted
 ?'line-through text-os-text-secondary'
 :`text-os-text-primary ${!isReadOnly ?'cursor-pointer hover:text-os-blue':''}`
 }`}
                onDoubleClick={() => !isReadOnly && setIsEditingDescription(true)}
                title={!isReadOnly ? "Double-click to edit" : ""}
              >
                {task.description}
              </p>
              {taskAge && (
                <span className="text-[9px] px-1 py-0.5 rounded-sm bg-os-card-secondary text-os-text-secondary">
                  {taskAge}
                </span>
              )}
            </div>
          )}

          {/* Metadata */}
          <div className="sc-task-meta flex items-center gap-1 flex-wrap text-[10px]">
            {/* Project */}
            {isEditingProject ? (
              <div className="relative z-50">
                <input
                  type="text"
                  value={projectValue}
                  onChange={handleProjectChange}
                  onKeyDown={handleProjectKeyDown}
                  onBlur={() => {
                    // Delay to allow clicking on suggestions
                    setTimeout(() => handleSaveProject(), 150);
                  }}
                  autoFocus
                  className="px-1.5 py-0.5 text-[11px] border border-os-blue rounded-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-hidden w-32 bg-os-input-bg text-os-text-primary"
                  placeholder="Project name"
                />
                {showProjectSuggestions && filteredProjects.length > 0 && (
                  <>
                    <div
                      className="fixed inset-0 z-100"
                      onClick={() => setShowProjectSuggestions(false)}
                    />
                    <div className="absolute top-full left-0 mt-1 z-101 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[150px] max-h-[200px] overflow-y-auto">
                      {filteredProjects.map((projectName) => (
                        <button
                          key={projectName}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleSelectProject(projectName);
                          }}
                          className="w-full px-3 py-1.5 text-left text-xs text-os-text-primary hover:bg-purple-50 dark:hover:bg-purple-900/20 flex items-center gap-2"
                        >
                          <FolderOpen size={12} />
                          {projectName}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : task.project ? (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-sm flex items-center gap-0.5 bg-os-card-secondary text-os-text-secondary border border-os-border ${!isReadOnly ?'cursor-pointer hover:border-os-blue':''}`}
                onClick={handleProjectClick}
                title={!isReadOnly ? "Click to edit" : ""}
              >
                <FolderOpen size={9} />
                {task.project}
              </span>
            ) : !isReadOnly && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary hover:text-os-blue cursor-pointer"
                onClick={handleProjectClick}
                title="Click to set project"
              >
                <FolderOpen size={11} />
                Project
              </span>
            )}

            {/* Priority */}
            {task.priority ? (
              <div className="relative">
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${
 task.priority ==='H'?'bg-red-500/10 text-red-700 dark:text-red-400 border border-red-500/20':
 task.priority ==='M'?'bg-yellow-500/10 text-yellow-800 dark:text-yellow-400 border border-yellow-500/20':
'bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/20'
 } ${!isReadOnly ?'cursor-pointer hover:opacity-90':''}`}
                  onClick={handlePriorityClick}
                >
                  <AlertCircle size={9} />
                  {priorityLabels[task.priority]}
                </span>
                {isEditingPriority && (
                  <>
                    <div className="fixed inset-0 z-100" onClick={() => setIsEditingPriority(false)} />
                    <div className="absolute top-full left-0 mt-1 z-101 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[100px]">
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
                  </>
                )}
              </div>
            ) : !isReadOnly && (
              <div className="relative">
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary hover:text-os-blue cursor-pointer"
                  onClick={handlePriorityClick}
                  title="Click to set priority"
                >
                  <AlertCircle size={11} />
                  Priority
                </span>
                {isEditingPriority && (
                  <>
                    <div className="fixed inset-0 z-100" onClick={() => setIsEditingPriority(false)} />
                    <div className="absolute top-full left-0 mt-1 z-101 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[100px]">
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
                  </>
                )}
              </div>
            )}

            {/* Tags */}
            {isEditingTags ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={tagsValue}
                  onChange={(e) => setTagsValue(e.target.value)}
                  onKeyDown={handleTagsKeyDown}
                  onBlur={handleSaveTags}
                  autoFocus
                  className="px-1.5 py-0.5 text-[11px] border border-os-blue rounded-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-hidden w-40 bg-os-input-bg text-os-text-primary"
                  placeholder="tag1, tag2, tag3"
                />
              </div>
            ) : task.tags && task.tags.length > 0 ? (
              <div
                className={`flex items-center gap-0.5 flex-wrap ${!isReadOnly ?'cursor-pointer':''}`}
                onClick={handleTagsClick}
                title={!isReadOnly ? "Click to edit" : ""}
              >
                {task.tags.map((tag, index) => (
                  <span
                    key={index}
                    className="text-[10px] px-1.5 py-0.5 bg-os-card-secondary text-os-text-secondary rounded-sm flex items-center gap-0.5 border border-os-border"
                  >
                    <Tag size={8} />
                    {tag}
                  </span>
                ))}
              </div>
            ) : !isReadOnly && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary hover:text-os-blue cursor-pointer"
                onClick={handleTagsClick}
                title="Click to add tags"
              >
                <Tag size={11} />
                Tags
              </span>
            )}

            {/* Due Date */}
            {isEditingDueDate ? (
              <DatePicker
                value={task.due ? task.due.split('T')[0] : ''}
                onChange={(newDate) => {
                  // Convert YYYY-MM-DD to ISO timestamp
                  const isoDate = newDate ? `${newDate}T00:00:00Z` : null;
                  onUpdate?.(task.id, { due: isoDate });
                  setIsEditingDueDate(false);
                }}
                onCancel={() => setIsEditingDueDate(false)}
                autoOpen={true}
                className="px-2 py-0.5 text-xs text-os-text-primary"
              />
            ) : task.due ? (
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 bg-orange-50 text-orange-700 border border-orange-200/50 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800/50 ${!isReadOnly ?'cursor-pointer hover:bg-orange-100 dark:hover:bg-orange-900/30':''}`}
                onClick={handleDueDateClick}
                title={!isReadOnly ? "Click to edit due date" : ""}
              >
                <Calendar size={11} />
                {new Date(task.due).toLocaleDateString()}
              </span>
            ) : !isReadOnly && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary hover:text-os-blue cursor-pointer"
                onClick={handleDueDateClick}
                title="Click to set due date"
              >
                <Calendar size={11} />
                Due
              </span>
            )}

            {/* Wait Date */}
            {isEditingWaitDate ? (
              <DatePicker
                value={task.wait ? task.wait.split('T')[0] : ''}
                onChange={(newDate) => {
                  // Convert YYYY-MM-DD to ISO timestamp
                  const isoDate = newDate ? `${newDate}T00:00:00Z` : null;
                  onUpdate?.(task.id, { wait: isoDate });
                  setIsEditingWaitDate(false);
                }}
                onCancel={() => setIsEditingWaitDate(false)}
                autoOpen={true}
                className="px-2 py-0.5 text-xs text-os-text-primary"
              />
            ) : task.wait ? (
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 bg-amber-50 text-amber-700 border border-amber-200/50 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/50 ${!isReadOnly ?'cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/30':''}`}
                onClick={handleWaitDateClick}
                title={!isReadOnly ? "Click to edit wait date" : ""}
              >
                <Clock size={11} />
                {new Date(task.wait).toLocaleDateString()}
              </span>
            ) : !isReadOnly && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary hover:text-os-blue cursor-pointer"
                onClick={handleWaitDateClick}
                title="Click to set wait date"
              >
                <Clock size={11} />
                Wait
              </span>
            )}

            {/* Active Timer */}
            {isActive && (
              <TaskTimer startTime={task.start} className="px-1.5 py-0.5 rounded-sm bg-green-50 border border-green-200/50 dark:bg-green-900/20 dark:border-green-800/50" />
            )}

            {/* Start/Stop buttons */}
            {!isReadOnly && !isCompleted && (
              <>
                {isActive ? (
                  <button
                    onClick={handleStopTask}
                    className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 bg-red-50 text-red-700 border border-red-200/50 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/50 hover:bg-red-100 dark:hover:bg-red-900/30"
                    title="Stop task"
                  >
                    <Square size={11} />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={handleStartTask}
                    className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 bg-green-50 text-green-700 border border-green-200/50 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800/50 hover:bg-green-100 dark:hover:bg-green-900/30"
                    title="Start task"
                  >
                    Start
                  </button>
                )}
              </>
            )}

            {/* Urgency (read-only, calculated by TaskWarrior) */}
            {task.urgency !== null && task.urgency !== undefined && task.urgency > 0 ? (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 bg-purple-50 text-purple-700 border border-purple-200/50 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-800/50"
                title="Urgency (calculated by TaskWarrior)"
              >
                <TrendingUp size={11} />
                {task.urgency.toFixed(1)}
              </span>
            ) : (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary"
                title="Urgency (calculated by TaskWarrior)"
              >
                <TrendingUp size={11} />
                Urgency
              </span>
            )}

            {/* Recurrence */}
            {task.recur ? (
              <div className="relative">
                <span
                  className={`text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200/50 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-800/50 ${!isReadOnly ?'cursor-pointer hover:bg-indigo-100 dark:hover:bg-indigo-900/30':''}`}
                  onClick={handleRecurClick}
                  title={!isReadOnly ? "Click to edit recurrence" : ""}
                >
                  <Repeat size={11} />
                  {task.recur}
                </span>
                {isEditingRecur && (
                  <>
                    <div className="fixed inset-0 z-100" onClick={() => setIsEditingRecur(false)} />
                    <div className="absolute top-full left-0 mt-1 z-101 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[140px] max-h-[300px] overflow-y-auto">
                      <button
                        onClick={() => handleRecurSelect('daily')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Daily
                      </button>
                      <button
                        onClick={() => handleRecurSelect('weekdays')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Weekdays
                      </button>
                      <button
                        onClick={() => handleRecurSelect('weekly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Weekly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('biweekly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Biweekly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('monthly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Monthly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('quarterly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Quarterly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('semiannual')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Semiannual
                      </button>
                      <button
                        onClick={() => handleRecurSelect('annual')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Annual
                      </button>
                      <button
                        onClick={() => handleRecurSelect('yearly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Yearly
                      </button>
                      <button
                        onClick={() => handleRecurSelect(null)}
                        className="w-full px-3 py-1.5 text-left text-xs text-os-text-muted hover:bg-os-card-secondary border-t border-os-border"
                      >
                        Clear
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : !isReadOnly && (
              <div className="relative">
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary hover:text-os-blue cursor-pointer"
                  onClick={handleRecurClick}
                  title="Click to set recurrence"
                >
                  <Repeat size={11} />
                  Repeat
                </span>
                {isEditingRecur && (
                  <>
                    <div className="fixed inset-0 z-100" onClick={() => setIsEditingRecur(false)} />
                    <div className="absolute top-full left-0 mt-1 z-101 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[140px] max-h-[300px] overflow-y-auto">
                      <button
                        onClick={() => handleRecurSelect('daily')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Daily
                      </button>
                      <button
                        onClick={() => handleRecurSelect('weekdays')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Weekdays
                      </button>
                      <button
                        onClick={() => handleRecurSelect('weekly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Weekly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('biweekly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Biweekly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('monthly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Monthly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('quarterly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Quarterly
                      </button>
                      <button
                        onClick={() => handleRecurSelect('semiannual')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Semiannual
                      </button>
                      <button
                        onClick={() => handleRecurSelect('annual')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Annual
                      </button>
                      <button
                        onClick={() => handleRecurSelect('yearly')}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-os-card-secondary flex items-center gap-2"
                      >
                        Yearly
                      </button>
                      <button
                        onClick={() => handleRecurSelect(null)}
                        className="w-full px-3 py-1.5 text-left text-xs text-os-text-muted hover:bg-os-card-secondary border-t border-os-border"
                      >
                        Clear
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Note - inline edit for annotations */}
            {!isReadOnly && (
              <div className="relative">
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 text-os-text-secondary hover:text-os-blue cursor-pointer"
                  onClick={() => setShowNoteInput(!showNoteInput)}
                  title="Click to add note"
                >
                  <MessageSquare size={11} />
                  Note
                </span>
              </div>
            )}

            {/* Cloud indicator */}
            {task.inCloud && (
              <span className="text-[11px] px-1.5 py-0.5 rounded-sm flex items-center gap-1 bg-blue-50 text-blue-700 border border-blue-200/50 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800/50">
                <Cloud size={11} />
                Shared
              </span>
            )}
          </div>

          {/* Annotations Section */}
          {task.annotations && task.annotations.length > 0 && (
            <div className="mt-2 space-y-1">
              {task.annotations.map((annotation, index) => (
                    <div key={index} className="flex items-start gap-1.5 text-[10px] group/annotation">
                      {!isReadOnly && onDenotate && (
                        <button
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            onDenotate(task, annotation.description);
                          }}
                          className="p-0.5 opacity-0 group-hover/annotation:opacity-100 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm transition-opacity text-red-500 dark:text-red-400 mt-0.5 shrink-0"
                          title="Remove note"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                      <MessageSquare size={10} className="text-os-text-muted mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <p className="text-os-text-primary text-[10px] leading-relaxed whitespace-pre-wrap">{annotation.description}</p>
                        {annotation.entry && (
                          <p className="text-os-text-muted text-[9px] mt-0.5 opacity-60">
                            {new Date(annotation.entry).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
            </div>
          )}

          {/* Note input textarea */}
          {!isReadOnly && showNoteInput && (
            <div className="mt-3">
              <textarea
                value={newAnnotation}
                onChange={(e) => setNewAnnotation(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey && newAnnotation.trim()) {
                    e.preventDefault();
                    handleAddAnnotation();
                    setShowNoteInput(false);
                  }
                  if (e.key === 'Escape') {
                    setNewAnnotation('');
                    setShowNoteInput(false);
                  }
                }}
                onBlur={() => {
                  if (newAnnotation.trim()) {
                    handleAddAnnotation();
                  }
                  setShowNoteInput(false);
                }}
                placeholder="Add note (Ctrl+Enter to save)"
                autoFocus
                rows={8}
                className="px-1.5 py-0.5 text-[11px] border border-os-blue rounded-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-hidden w-full bg-os-input-bg text-os-text-primary resize-none"
              />
            </div>
          )}

        </div>

        {/* Actions */}
        {!isReadOnly && (
          <button
            onClick={() => onDelete?.(task)}
            className="p-1 opacity-0 group-hover:opacity-100 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm transition-opacity text-red-500 dark:text-red-400 shrink-0"
            title="Delete task"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
