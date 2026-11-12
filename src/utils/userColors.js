/**
 * User Color Utility
 * Generates consistent colors for different users based on their machine ID
 */
import { paint } from './dataColour.js';

/**
 * Generate a consistent color for a user based on their ID
 * @param {string} userId - The user's machine ID (e.g., "user@hostname")
 * @returns {string} - A Tailwind-compatible border color class
 */
export function getUserBorderColor(userId) {
  if (!userId) {
    return 'border-(--brand-accent)'; // Default purple for unknown users
  }

  // Hash the userId to get a consistent number
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Use absolute value to ensure positive number
  hash = Math.abs(hash);

  // Define a palette of distinct, vibrant colors
  // the categorical set of the charts (--chart-cat-1..8: one colour per category everywhere; the colour-vision
  // palettes replace it with an Okabe-Ito order), so a collaborator's colour follows the palette too
  const colors = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `border-(--chart-cat-${n})`);

  // Select color based on hash
  return colors[hash % colors.length];
}

/**
 * Get inline style for border color (for dynamic colors)
 * @param {string} userId - The user's machine ID
 * @returns {object} - Style object with borderLeftColor
 */
export function getUserBorderStyle(userId) {
  return paint(getUserColor(userId), 'borderLeftColor');   // display: a colour-vision palette maps it (src/utils/dataColour.js)
}

/** The user's colour as a hex value (data: the Yjs awareness colour others see; use getUserBorderStyle / paint() to display it). */
export function getUserColor(userId) {
  if (!userId) {
    return '#9333ea'; // Purple-600
  }

  // Hash the userId
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash;
  }
  hash = Math.abs(hash);

  // Color palette with hex values
  const colors = [
    '#2563eb', // Blue-600
    '#16a34a', // Green-600
    '#ca8a04', // Yellow-600
    '#dc2626', // Red-600
    '#4f46e5', // Indigo-600
    '#db2777', // Pink-600
    '#0d9488', // Teal-600
    '#ea580c', // Orange-600
    '#0891b2', // Cyan-600
    '#65a30d', // Lime-600
    '#e11d48', // Rose-600
    '#7c3aed', // Violet-600
    '#d97706', // Amber-600
    '#059669', // Emerald-600
    '#c026d3', // Fuchsia-600
    '#0284c7', // Sky-600
  ];

  return colors[hash % colors.length];
}

/**
 * Get user color (for cursors, highlights, etc.)
 * @param {string} userId - The user's machine ID
 * @returns {string} - Hex color code
 */

/**
 * Get subtle/pastel version of user color for backgrounds
 * @param {string} userId - The user's machine ID
 * @param {number} opacity - Opacity value (0-1)
 * @returns {string} - RGBA color code
 */
export function getUserColorSubtle(userId, opacity = 0.15) {
  const hexColor = getUserColor(userId);

  // Convert hex to RGB
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Get darker user color for dark theme backgrounds (chat bubbles, etc.)
 * @param {string} userId - The user's machine ID
 * @returns {string} - Hex color code (darker shade)
 */
export function getUserColorDark(userId) {
  if (!userId) {
    return '#7c3aed'; // Violet-600 as default
  }

  // Hash the userId
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash;
  }
  hash = Math.abs(hash);

  // Darker color palette (700-800 shades) for dark theme
  const colors = [
    '#1e40af', // Blue-800
    '#15803d', // Green-700
    '#a16207', // Yellow-700
    '#b91c1c', // Red-700
    '#4338ca', // Indigo-700
    '#be185d', // Pink-700
    '#0f766e', // Teal-700
    '#c2410c', // Orange-700
    '#0e7490', // Cyan-700
    '#4d7c0f', // Lime-700
    '#be123c', // Rose-700
    '#6d28d9', // Violet-700
    '#b45309', // Amber-700
    '#047857', // Emerald-700
    '#a21caf', // Fuchsia-700
    '#0369a1', // Sky-700
  ];

  return colors[hash % colors.length];
}

/**
 * Convert hex color to rgba with opacity
 * @param {string} hexColor - Hex color code (e.g., "#2563eb")
 * @param {number} opacity - Opacity value (0-1)
 * @returns {string} - RGBA color code
 */
export function hexToRgba(hexColor, opacity = 1) {
  // Remove # if present
  const hex = hexColor.replace('#', '');

  // Convert hex to RGB
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
