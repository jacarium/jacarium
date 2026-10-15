/**
 * Colour palette shared by the freeform (mind-map) nodes. Tints are
 * translucent so they read correctly on both light and dark canvases.
 */
export const NOTE_COLORS = {
  yellow: { label: 'Yellow', solid: '#eab308', tint: 'rgba(234, 179, 8, 0.16)', border: 'rgba(234, 179, 8, 0.7)' },
  green:  { label: 'Green',  solid: '#22c55e', tint: 'rgba(34, 197, 94, 0.16)', border: 'rgba(34, 197, 94, 0.7)' },
  blue:   { label: 'Blue',   solid: '#3b82f6', tint: 'rgba(59, 130, 246, 0.16)', border: 'rgba(59, 130, 246, 0.7)' },
  purple: { label: 'Purple', solid: '#a855f7', tint: 'rgba(168, 85, 247, 0.16)', border: 'rgba(168, 85, 247, 0.7)' },
  pink:   { label: 'Pink',   solid: '#ec4899', tint: 'rgba(236, 72, 153, 0.16)', border: 'rgba(236, 72, 153, 0.7)' },
  gray:   { label: 'Gray',   solid: '#9ca3af', tint: 'rgba(156, 163, 175, 0.16)', border: 'rgba(156, 163, 175, 0.7)' }
};

export const NOTE_COLOR_KEYS = Object.keys(NOTE_COLORS);
export const DEFAULT_NOTE_COLOR = 'yellow';

export function getNoteColor(key) {
  return NOTE_COLORS[key] || NOTE_COLORS[DEFAULT_NOTE_COLOR];
}
