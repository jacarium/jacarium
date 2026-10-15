import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import BaseModal from '../common/modals/BaseModal';
import DatePicker from '../common/inputs/DatePicker';

export default function CardModal({ isOpen, onClose, onSave, card }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [tags, setTags] = useState('');

  useEffect(() => {
    if (card) {
      // Intentional prop-to-state sync when the modal (re)opens; a keyed
      // remount would be the deeper fix, but this matches every other modal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(card.title || '');
      setDescription(card.description || '');
      setPriority(card.priority || 'medium');
      setAssignee(card.assignee || '');
      setDueDate(card.dueDate || '');
      setTags(card.tags ? card.tags.join(', ') : '');
    } else {
      setTitle('');
      setDescription('');
      setPriority('medium');
      setAssignee('');
      setDueDate('');
      setTags('');
    }
  }, [card, isOpen]);

  function handleSubmit(e) {
    e.preventDefault();

    if (!title.trim()) {
      return;
    }

    const cardData = {
      title: title.trim(),
      description: description.trim(),
      priority,
      assignee: assignee.trim(),
      dueDate: dueDate || null,
      tags: tags
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0)
    };

    onSave(cardData);
  }

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} className="max-w-2xl w-full">
      {/* Header */}
      <div className="p-4 border-b border-os-border bg-os-card flex items-center justify-between">
        <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
          {card ? 'Edit Card' : 'New Card'}
        </h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-os-sidebar-hover transition-colors"
        >
          <X size={20} className="text-os-text-secondary" />
        </button>
      </div>

      {/* Body */}
      <form onSubmit={handleSubmit} className="p-6 space-y-4 bg-os-card">
        {/* Title */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Title *
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Card title"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            autoFocus
            required
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Card description"
            rows={4}
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary resize-none"
          />
        </div>

        {/* Priority & Assignee Row */}
        <div className="grid grid-cols-2 gap-4">
          {/* Priority */}
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Priority
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          {/* Assignee */}
          <div>
            <label className="block text-sm text-os-text-primary mb-2">
              Assignee
            </label>
            <input
              type="text"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="Name or email"
              className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary"
            />
          </div>
        </div>

        {/* Due Date */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Due Date
          </label>
          <DatePicker
            value={dueDate}
            onChange={setDueDate}
            placeholder="Select due date"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary"
          />
        </div>

        {/* Tags */}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">
            Tags
          </label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Comma-separated tags (e.g., bug, feature, urgent)"
            className="w-full px-3 py-2 border border-os-input-border rounded-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary"
          />
          <p className="mt-1 text-xs text-os-text-muted">
            Enter tags separated by commas
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-os-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-os-text-secondary hover:bg-os-card-secondary rounded-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 bg-blue-600 text-white text-sm hover:bg-blue-700 rounded-sm transition-colors"
          >
            {card ? 'Save Changes' : 'Create Card'}
          </button>
        </div>
      </form>
    </BaseModal>
  );
}
