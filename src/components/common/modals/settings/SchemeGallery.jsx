/**
 * The colour scheme picker of Settings > Theme: every scheme as a tile (the
 * mark in its logo colours on its rail, the swatch strip: rail, background,
 * card, accent, text) in three groups - the app's built-in schemes (Auto,
 * Light, Jacaranda, Dark, the gradient themes), the palettes
 * (src/utils/themeStarters.js, applied as they are under 'starter-<id>')
 * and the user's saved themes. Clicking a tile applies that scheme at once;
 * the group is a radio group for the keyboard (the arrows move and choose,
 * Home / End jump, the chosen tile holds the tab stop).
 */
import { useRef } from 'react';
import { Check } from 'lucide-react';
import BrandMark from '../../../../brand/BrandMark';
import { DARK_THEMES, GRADIENT_THEMES } from '../../../../contexts/ThemeContext';
import { THEME_STARTERS, schemeModel, starterSchemeId } from '../../../../utils/themeStarters';
import { fillToCss, themeSchemeId } from '../../../../utils/customThemes';

function Strip({ theme }) {
  const c = theme.colors;
  const swatches = [
    ['rail', fillToCss(theme.fills?.rail) || c.sidebar], ['background', c.canvas], ['card', c.card], ['accent', c.accent], ['text', c.textPrimary],
  ];
  return (
    <span className="flex h-5 rounded-sm overflow-hidden border border-os-border" aria-hidden="true">
      {swatches.map(([what, css]) => <span key={what} className="flex-1" style={{ background: css }} title={what} />)}
    </span>
  );
}

export function SchemeTile({ id, name, theme, active, tabIndex, onSelect, hint, innerRef }) {
  const c = theme.colors;
  return (
    <button
      ref={innerRef}
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={tabIndex}
      onClick={() => onSelect(id)}
      className={`text-left rounded-sm border bg-os-card p-2 flex items-center gap-3 min-w-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${active ? 'border-os-blue ring-1 ring-os-blue' : 'border-os-border hover:border-os-blue'}`}
      data-testid={`scheme-card-${id}`}
      data-active={active ? 'true' : undefined}
      title={hint}
    >
      <span className="w-10 h-10 shrink-0 rounded-sm flex items-center justify-center" style={{ background: fillToCss(theme.fills?.rail) || c.sidebar, '--mark-arch': c.markArch, '--mark-blossom': c.markBlossom, '--mark-center': c.markCenter || c.markArch }}>
        <BrandMark size={28} tone="dark" decoration="none" title={`${name} mark`} />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-1.5 text-xs text-os-text-primary">
          <span className="truncate">{name}</span>
          {active && <Check size={12} className="shrink-0 text-os-blue" aria-label="active" />}
        </span>
        <Strip theme={theme} />
      </span>
    </button>
  );
}

export default function SchemeGallery({ theme, customThemes, onSelect, systemDark = true }) {
  const refs = useRef([]);
  const builtIn = [
    { id: 'auto', name: 'Auto (System)', hint: 'follows the system: Jacaranda in the dark, Light otherwise' },
    { id: 'light', name: 'Light' },
    ...Object.entries(DARK_THEMES).map(([id, cfg]) => ({ id, name: cfg.name })),
    ...Object.entries(GRADIENT_THEMES).map(([id, cfg]) => ({ id, name: cfg.name, hint: cfg.description })),
  ].map((s) => ({ ...s, theme: schemeModel(s.id, customThemes, systemDark) })).filter((s) => s.theme);
  const palettes = THEME_STARTERS.filter((s) => s.group === 'Palettes').map((s) => ({ id: starterSchemeId(s), name: s.name, theme: s.theme, hint: `${s.source.name} palette (${s.source.licence}) - ${s.source.url}` }));
  const crazy = THEME_STARTERS.filter((s) => s.group === 'Crazy').map((s) => ({ id: starterSchemeId(s), name: s.name, theme: s.theme, hint: 'a showcase scheme with a gradient rail' }));
  const yours = customThemes.map((t) => ({ id: themeSchemeId(t), name: t.name, theme: t, hint: 'one of your themes' }));
  const groups = [['Built-in schemes', builtIn], ['Palettes', palettes], ['Crazy', crazy], ['Your themes', yours]];
  const all = groups.flatMap(([, list]) => list);
  const activeIndex = Math.max(0, all.findIndex((s) => s.id === theme));

  // the radio group's keys: the arrows choose the neighbour, Home / End the ends
  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next = null;
    if (step) next = (activeIndex + step + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next === null) return;
    e.preventDefault();
    onSelect(all[next].id);
    refs.current[next]?.focus();
  };

  let index = -1;
  return (
    <div role="radiogroup" aria-label="Color scheme" className="space-y-4" data-testid="scheme-gallery" onKeyDown={onKeyDown}>
      {groups.map(([title, list]) => (
        <div key={title}>
          <p className="text-xs font-medium text-os-text-primary mb-2">{title}</p>
          {list.length === 0 ? (
            <p className="text-xs text-os-text-muted" data-testid="scheme-gallery-empty">Save a customised scheme below and it appears here.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((s) => { index += 1; const i = index; return (
                <SchemeTile key={s.id} id={s.id} name={s.name} theme={s.theme} hint={s.hint} active={i === activeIndex} tabIndex={i === activeIndex ? 0 : -1} onSelect={onSelect} innerRef={(el) => { refs.current[i] = el; }} />
              ); })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
