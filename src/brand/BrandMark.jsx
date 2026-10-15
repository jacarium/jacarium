/**
 * The Jacarium mark: an arch holding a jacaranda blossom (public/brand/mark.svg
 * and mark-light.svg carry the same shapes as files). Inline SVG so it needs
 * no request and follows the theme: the arch and the centre are the brand
 * accent, the blossom is white on light surfaces and lilac on dark ones
 * (--brand-blossom in src/index.css). `tone` forces one of the two when the
 * mark sits on a surface that does not follow the theme (the sidebar rail is
 * dark in both themes).
 *
 *   <BrandMark size={36} />                 follows the theme
 *   <BrandMark size={36} tone="dark" />     lilac blossom (dark surface)
 *   <BrandMark size={36} tone="light" />    white blossom (light surface)
 *
 * The colours are CSS variables so a colour scheme can restyle the mark:
 * --mark-arch (the arch and, through --mark-center, the centre dot) and
 * --mark-blossom; the defaults are the brand violet and the tone's blossom.
 * The gradient themes set them in src/index.css ([data-theme="gradient-*"])
 * to a tinted-white arch with the blossom in the theme's deep tone. Only the
 * in-app mark follows the theme: the app icon (OS, favicon) stays violet.
 *
 * The wordmark next to it is plain text in the brand font: <BrandWordmark />.
 */
import { brandTagline } from './brand';

const ACCENT = '#7B5CE0';
const BLOSSOM = { dark: '#EDE6FF', light: '#FFFFFF' };
const PETALS = [0, 72, 144, 216, 288];

export default function BrandMark({ size = 32, tone = 'auto', className = '', title = 'Jacarium' }) {
  const toneBlossom = tone === 'auto' ? 'var(--brand-blossom, #FFFFFF)' : BLOSSOM[tone] || BLOSSOM.light;
  const arch = `var(--mark-arch, ${ACCENT})`;
  const blossom = `var(--mark-blossom, ${toneBlossom})`;
  const center = `var(--mark-center, var(--mark-arch, ${ACCENT}))`;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={title} className={className} focusable="false" data-brand="mark">
      <path d="M22 110 V54 A38 38 0 0 1 98 54 V110 Z" fill={arch} />
      <g fill={blossom}>
        {PETALS.map((deg) => <ellipse key={deg} cx="60" cy="49" rx="8.5" ry="13" transform={`rotate(${deg} 60 64)`} />)}
      </g>
      <circle cx="60" cy="64" r="5" fill={center} />
    </svg>
  );
}

/** "Jacarium" in the brand font (Sora 600, tight tracking); `size` is the font size in px. */
export function BrandWordmark({ size = 24, className = '' }) {
  return <span className={`brand-wordmark ${className}`} style={{ fontSize: size }}>Jacarium</span>;
}

/** Mark + wordmark (+ optional tagline) in a row, the header of the brand pages. */
export function BrandLockup({ markSize = 56, wordmarkSize = 30, tagline = false, className = '' }) {
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      <BrandMark size={markSize} />
      <div className="min-w-0">
        <BrandWordmark size={wordmarkSize} />
        {tagline && <p className="brand-tagline mt-1 text-sm">{brandTagline()}</p>}
      </div>
    </div>
  );
}
