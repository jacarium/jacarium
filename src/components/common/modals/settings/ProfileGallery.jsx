/**
 * The accessibility profiles (src/utils/readingAidProfiles.js) as a row of
 * cards at the top of Settings > Accessibility, built like the colour
 * scheme tiles: a radio group for the keyboard (the arrows move and choose,
 * Home / End jump, the chosen card holds the tab stop), each card with a
 * tiny preview, the name and a one-line description, the chosen one marked
 * with a check and a ring, never by colour alone. When the current settings
 * match no profile, no card is checked and a "Custom" note names the
 * profile they were based on.
 */
import { useRef } from 'react';
import { Check } from 'lucide-react';
import { PROFILES, profileById } from '../../../../utils/readingAidProfiles';

/** The tiny preview: two text lines and "Aa" in the profile's manner. */
function Preview({ preview }) {
  const kind = preview.kind;
  const font = preview.font || undefined;
  const box = `w-12 h-10 shrink-0 rounded-sm border border-os-border overflow-hidden relative flex flex-col justify-center gap-1 px-1.5 ${kind === 'contrast' ? 'bg-os-text-primary text-os-card' : 'bg-os-card text-os-text-primary'}`;
  const style = kind === 'calm' ? { filter: 'saturate(0.6)' } : undefined;
  return (
    <span className={box} style={style} aria-hidden="true" data-preview={kind}>
      {kind === 'mask' && <span className="absolute inset-x-0 top-0 h-3 bg-os-text-primary/35" />}
      {kind === 'mask' && <span className="absolute inset-x-0 bottom-0 h-3 bg-os-text-primary/35" />}
      {kind === 'spaced' && <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-3 bg-os-blue/20" />}
      <span className="relative flex items-center gap-1">
        <span className={`font-semibold leading-none ${kind === 'contrast' ? 'text-base' : 'text-xs'}`} style={{ fontFamily: font, letterSpacing: kind === 'spaced' ? '0.12em' : undefined }}>Aa</span>
        {kind === 'palette' && preview.colors.map((c) => <span key={c} className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />)}
      </span>
      <span className={`relative block h-0.5 rounded-full ${kind === 'contrast' ? 'bg-os-card' : 'bg-os-text-muted'} ${kind === 'airy' ? 'mt-1' : ''}`} style={{ width: kind === 'airy' ? '60%' : '80%' }} />
      <span className={`relative block h-0.5 rounded-full ${kind === 'contrast' ? 'bg-os-card' : 'bg-os-text-muted'}`} style={{ width: kind === 'airy' ? '45%' : '55%' }} />
    </span>
  );
}

export function ProfileCard({ profile, active, tabIndex, onSelect, innerRef }) {
  return (
    <button
      ref={innerRef}
      type="button"
      role="radio"
      aria-checked={active}
      aria-describedby={`ra-profile-${profile.id}-desc`}
      tabIndex={tabIndex}
      onClick={() => onSelect(profile.id)}
      className={`text-left rounded-sm border bg-os-card p-2 flex items-start gap-3 min-w-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40 ${active ? 'border-os-blue ring-1 ring-os-blue' : 'border-os-border hover:border-os-text-muted'}`}
      data-testid={`ra-profile-${profile.id}`}
      data-active={active ? 'true' : undefined}
    >
      <Preview preview={profile.preview} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs text-os-text-primary">
          <span className="min-w-0 break-words">{profile.name}</span>
          {active && <Check size={12} className="shrink-0 text-os-blue" aria-label="selected" />}
        </span>
        <span id={`ra-profile-${profile.id}-desc`} className="block text-2xs leading-snug text-os-text-secondary">{profile.description}</span>
      </span>
    </button>
  );
}

export default function ProfileGallery({ match, basedOn, onSelect }) {
  const refs = useRef([]);
  const activeIndex = PROFILES.findIndex((p) => p.id === match);
  const startIndex = activeIndex >= 0 ? activeIndex : Math.max(0, PROFILES.findIndex((p) => p.id === basedOn));
  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next = null;
    if (step) next = (startIndex + step + PROFILES.length) % PROFILES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = PROFILES.length - 1;
    if (next === null) return;
    e.preventDefault();
    onSelect(PROFILES[next].id);
    refs.current[next]?.focus();
  };
  const based = basedOn ? profileById(basedOn) : null;
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Accessibility profile" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="ra-profiles" onKeyDown={onKeyDown}>
        {PROFILES.map((p, i) => (
          <ProfileCard key={p.id} profile={p} active={i === activeIndex} tabIndex={i === startIndex ? 0 : -1} onSelect={onSelect} innerRef={(el) => { refs.current[i] = el; }} />
        ))}
      </div>
      <p className="text-xs text-os-text-secondary" role="status" data-testid="ra-profile-state">
        {match ? `Profile: ${profileById(match).name}.` : based ? `Custom (based on ${based.name}): the settings below differ from the profile.` : 'Custom: the settings below match no profile.'}
      </p>
    </div>
  );
}
