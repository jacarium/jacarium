import { useState } from 'react';
import { Plus, GripVertical, Trash2 } from 'lucide-react';
import KanbanCard from './KanbanCard';
import InlineEdit from '../common/inputs/InlineEdit';

const COLUMN_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f97316', // orange
  '#6366f1', // indigo
];

export default function KanbanColumn({
  column,
  cards,
  onCreateCard,
  onDeleteCard,
  onRenameCard,
  onUpdateCardDescription,
  onUpdateCard,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  isDraggedOver,
  onRenameColumn,
  onUpdateColumnColor,
  onDeleteColumn,
  onColumnDragStart,
  onColumnDragOver,
  onColumnDrop,
  isColumnDraggedOver,
  userInteractions,
  connectedUsers = [],
  isReadOnly = false
}) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  function handleDoubleClick(e) {
    if (isReadOnly) return;
    e.stopPropagation();
    setIsEditingTitle(true);
  }

  function handleSaveTitle(newTitle) {
    if (newTitle.trim() && newTitle !== column.title) {
      onRenameColumn?.(column.id, newTitle.trim());
    }
    setIsEditingTitle(false);
  }

  const [isDraggingColumn, setIsDraggingColumn] = useState(false);

  function handleColumnDragStart(e) {
    e.dataTransfer.effectAllowed = 'move';
    setIsDraggingColumn(true);
    onColumnDragStart?.(column);
  }

  function handleColumnDragEnd() {
    setIsDraggingColumn(false);
  }

  return (
    <div
      className={`sc-kanban-column flex flex-col w-80 bg-os-card-secondary rounded-lg shrink-0 transition-all group ${
 isDraggingColumn ?'opacity-40':''
 } ${
 isColumnDraggedOver ?'ring-2 ring-os-blue ring-offset-2':''
 }`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onColumnDragOver?.(e, column);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onColumnDrop?.(e, column);
      }}
    >
      {/* Column Header */}
      <div
        className={`sc-kanban-column-header flex items-center justify-between p-4 border-b border-os-border ${!isReadOnly ?'cursor-grab active:cursor-grabbing':''}`}
        draggable={!isReadOnly}
        onDragStart={!isReadOnly ? handleColumnDragStart : undefined}
        onDragEnd={!isReadOnly ? handleColumnDragEnd : undefined}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GripVertical size={16} className="text-os-text-muted shrink-0" />

          {/* Color Picker */}
          <div className="relative">
            <div
              className={`w-3 h-3 rounded-full shrink-0 ${!isReadOnly ?'cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-os-text-muted':''}`}
              style={{ backgroundColor: column.color }}
              onClick={(e) => {
                if (isReadOnly) return;
                e.stopPropagation();
                setShowColorPicker(!showColorPicker);
              }}
              title={!isReadOnly ? "Click to change color" : ""}
            />
            {showColorPicker && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowColorPicker(false)}
                />
                <div className="absolute top-6 left-0 z-20 bg-os-card border border-os-border shadow-lg rounded-md p-2 grid grid-cols-5 gap-2">
                  {COLUMN_COLORS.map((color) => (
                    <button
                      key={color}
                      className="w-6 h-6 rounded-full hover:ring-2 hover:ring-offset-1 hover:ring-os-text-muted transition-all"
                      style={{ backgroundColor: color }}
                      onClick={() => {
                        onUpdateColumnColor?.(column.id, color);
                        setShowColorPicker(false);
                      }}
                      title={color}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {isEditingTitle ? (
            <InlineEdit
              value={column.title}
              onSave={handleSaveTitle}
              onCancel={() => setIsEditingTitle(false)}
              isEditing={true}
              onEditingChange={(editing) => {
                if (!editing) {
                  setIsEditingTitle(false);
                }
              }}
              className="flex-1"
              inputClassName="text-sm font-semibold"
            />
          ) : (
            <h3
              className="text-sm font-semibold text-os-text-primary cursor-pointer hover:text-os-blue transition-colors"
              onDoubleClick={handleDoubleClick}
              title="Double-click to rename"
            >
              {column.title}
            </h3>
          )}
          <span className="text-xs text-os-text-muted bg-os-card-secondary px-2 py-0.5 rounded-full shrink-0">
            {cards.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!isReadOnly && (
            <>
              <button
                onClick={onCreateCard}
                className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
              >
                <Plus size={16} className="text-os-text-secondary" />
              </button>
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteConfirm(!showDeleteConfirm);
                  }}
                  className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Trash2 size={14} className="text-red-600" />
                </button>
                {showDeleteConfirm && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowDeleteConfirm(false)}
                    />
                    <div className="absolute right-0 top-8 z-20 bg-os-card border border-os-border shadow-lg rounded-md p-3 min-w-[200px]">
                      <p className="text-sm text-os-text-primary mb-3">
                        Delete column "{column.title}"?
                        {cards.length > 0 && (
                          <span className="block text-xs text-red-600 mt-1">
                            This will delete {cards.length} card{cards.length !== 1 ? 's' : ''}.
                          </span>
                        )}
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            onDeleteColumn?.(column.id);
                            setShowDeleteConfirm(false);
                          }}
                          className="btn btn-danger-solid flex-1 px-3 py-1.5 text-sm"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setShowDeleteConfirm(false)}
                          className="flex-1 px-3 py-1.5 border border-os-border text-sm rounded-sm hover:bg-os-card-secondary"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Cards Container */}
      <div
        className={`flex-1 overflow-y-auto p-3 space-y-2 min-h-[200px] transition-colors ${
 isDraggedOver ?'bg-blue-50 border-2 border-blue-300 border-dashed':''
 }`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {cards.map(card => (
          <KanbanCard
            key={card.id}
            card={card}
            onDelete={() => onDeleteCard(card.id)}
            onRenameCard={onRenameCard}
            onUpdateDescription={onUpdateCardDescription}
            onUpdateCard={onUpdateCard}
            onDragStart={() => onDragStart(card)}
            userInteractions={userInteractions}
            connectedUsers={connectedUsers}
            isReadOnly={isReadOnly}
          />
        ))}
        {cards.length === 0 && !isDraggedOver && (
          <div className="text-center text-os-text-muted text-sm py-8">
            Drop cards here or click + to add
          </div>
        )}
      </div>
    </div>
  );
}
