/**
 * The custom theme editor (Settings > Theme > Customize): the name,
 * the base, the seasonal logos' variant, the colours in their groups (the
 * shared colour picker, src/components/ui/ColorPickerInput.jsx), the rail's
 * fill (a colour, a linear or a radial gradient with two or three stops),
 * the contrast warnings and a preview card with the mark. Every change goes
 * up through onChange as a draft theme (src/utils/customThemes.js); the
 * Theme panel previews a changed draft on the whole app, so
 * the preview card is the app itself in miniature.
 */
import { useState } from 'react';
import { Button, Field, Note, NumberInput, Segmented, Select, TextInput } from './ui';
import ColorPickerInput from '../../../ui/ColorPickerInput';
import BrandMark from '../../../../brand/BrandMark';
import { DECORATIONS } from '../../../../brand/seasonal';
import { COLOR_FIELDS, MAX_FILL_STOPS, MIN_FILL_STOPS, MAX_THEME_NAME_LENGTH, contrastWarnings, fillToCss, validateFill } from '../../../../utils/customThemes';

const GROUPS = ['Surfaces', 'Text', 'Accent', 'Status', 'Navigation', 'Logo'];

function FillEditor({ value, onChange }) {
  const type = value?.type || 'solid';
  const stops = value?.stops || [{ color: value?.color || '#1b1530', at: 0 }, { color: value?.color || '#1b1530', at: 100 }];
  const setType = (next) => {
    if (next === 'solid') onChange({ type: 'solid', color: stops[0].color });
    else if (next === 'linear') onChange({ type: 'linear', angle: value?.angle ?? 180, stops: stops.map((s, i) => ({ color: s.color, at: s.at ?? Math.round((100 * i) / (stops.length - 1)) })) });
    else onChange({ type: 'radial', stops: stops.map((s, i) => ({ color: s.color, at: s.at ?? Math.round((100 * i) / (stops.length - 1)) })) });
  };
  const setStop = (i, patch) => onChange({ ...value, stops: stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const css = fillToCss(value);
  return (
    <div className="space-y-2" data-testid="custom-theme-rail-fill">
      <Segmented size="sm" value={type} onChange={setType} testId="custom-theme-rail-fill-type" options={[{ id: 'solid', label: 'Solid' }, { id: 'linear', label: 'Linear gradient' }, { id: 'radial', label: 'Radial gradient' }]} />
      {type === 'solid' ? (
        <ColorPickerInput value={value?.color || ''} onChange={(color) => onChange({ type: 'solid', color })} label="Rail" testId="custom-theme-color-rail" />
      ) : (
        <div className="space-y-2">
          {stops.map((s, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap">
              <ColorPickerInput value={s.color} onChange={(color) => setStop(i, { color })} label={`Stop ${i + 1}`} testId={`custom-theme-rail-stop-${i + 1}`} />
              <div className="w-20 shrink-0"><NumberInput value={s.at} min={0} max={100} onChange={(e) => setStop(i, { at: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} aria-label={`Stop ${i + 1} position`} /></div>
              <span className="text-xs text-os-text-muted">%</span>
              {stops.length > MIN_FILL_STOPS && <Button size="sm" variant="ghost" onClick={() => onChange({ ...value, stops: stops.filter((_, k) => k !== i) })}>Remove</Button>}
            </div>
          ))}
          <div className="flex items-center gap-3 flex-wrap">
            {stops.length < MAX_FILL_STOPS && <Button size="sm" onClick={() => onChange({ ...value, stops: [...stops, { color: stops[stops.length - 1].color, at: 100 }] })} data-testid="custom-theme-rail-add-stop">Add stop</Button>}
            {type === 'linear' && (
              <label className="flex items-center gap-2 text-xs text-os-text-secondary">Angle
                <span className="w-20 shrink-0"><NumberInput value={value?.angle ?? 180} min={0} max={360} onChange={(e) => onChange({ ...value, angle: Math.max(0, Math.min(360, Number(e.target.value) || 0)) })} aria-label="Angle" data-testid="custom-theme-rail-angle" /></span>
                <span className="text-os-text-muted">deg</span>
              </label>
            )}
          </div>
        </div>
      )}
      <div className="h-8 rounded-sm border border-os-border" style={css ? { background: css } : undefined} aria-hidden="true" data-testid="custom-theme-rail-fill-preview" />
    </div>
  );
}

export default function CustomThemeEditor({ theme, onChange, nameError = '', footer = null }) {
  const [decoration, setDecoration] = useState('none');
  const warnings = contrastWarnings(theme).filter((w) => w.ratio < w.min);
  const setColor = (key, value) => onChange({ ...theme, colors: { ...theme.colors, [key]: value || null } });
  const fillOk = validateFill(theme.fills?.rail).ok;
  return (
    <div className="space-y-4" data-testid="custom-theme-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" error={nameError}>
          <TextInput value={theme.name} onChange={(e) => onChange({ ...theme, name: e.target.value })} maxLength={MAX_THEME_NAME_LENGTH} data-testid="custom-theme-name" aria-label="Theme name" />
        </Field>
        <Field label="Base" hint="the built-in theme it starts from: the syntax colours, radii and fonts stay the base's">
          <Segmented value={theme.base} onChange={(base) => onChange({ ...theme, base })} testId="custom-theme-base" options={[{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }]} />
        </Field>
      </div>
      {GROUPS.map((group) => (
        <div key={group}>
          <p className="text-xs font-medium text-os-text-primary mb-2">{group}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COLOR_FIELDS.filter((f) => f.group === group).map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <ColorPickerInput value={theme.colors[f.key] || ''} onChange={(v) => setColor(f.key, v)} label={f.label} allowEmpty={!!f.optional} testId={`custom-theme-color-${f.key}`} />
              </Field>
            ))}
            {group === 'Navigation' && (
              <Field label="Rail" hint="a colour, or a gradient as the themed sidebars paint it" className="sm:col-span-2 lg:col-span-3" error={fillOk ? '' : 'the fill is not complete'}>
                <FillEditor value={theme.fills?.rail} onChange={(rail) => onChange({ ...theme, fills: { ...theme.fills, rail } })} />
              </Field>
            )}
            {group === 'Logo' && (
              <Field label="Seasonal logos" hint="the celebration logos' variant (the dark themes' by default)">
                <Segmented value={theme.logoTone || 'dark'} onChange={(logoTone) => onChange({ ...theme, logoTone })} testId="custom-theme-logo-tone" options={[{ id: 'dark', label: 'Dark variant' }, { id: 'light', label: 'Light variant' }]} />
              </Field>
            )}
          </div>
        </div>
      ))}
      <div>
        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <p className="text-xs font-medium text-os-text-primary">Preview</p>
          <label className="flex items-center gap-2 text-xs text-os-text-secondary">Decoration
            <Select size="sm" value={decoration} onChange={(e) => setDecoration(e.target.value)} data-testid="custom-theme-preview-decoration">
              <option value="none">None</option>
              {DECORATIONS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </label>
        </div>
        <div className="rounded-sm border border-os-border overflow-hidden flex" data-testid="custom-theme-preview">
          <div className="w-14 shrink-0 flex flex-col items-center py-3 gap-2" style={{ background: fillToCss(theme.fills?.rail) || 'var(--os-rail)' }}>
            <BrandMark size={36} tone="dark" decoration={decoration} />
            <span className="w-7 h-7 rounded-sm bg-os-rail-active" aria-hidden="true" />
            <span className="w-7 h-7 rounded-sm" style={{ background: 'var(--os-rail-hover)' }} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0 bg-os-canvas p-3 space-y-3">
            <div className="bg-os-card border border-os-border rounded-sm p-3 space-y-2">
              <p className="text-sm text-os-text-primary">Text on a card, with <a href="#preview" onClick={(e) => e.preventDefault()} style={{ color: 'var(--link)' }}>a link</a></p>
              <p className="text-xs text-os-text-secondary">Secondary text - a label or a hint</p>
              <p className="text-xs text-os-text-muted">Muted text - a timestamp, a count</p>
              <div className="flex gap-2 flex-wrap">
                <Button size="sm" variant="primary">Primary</Button>
                <Button size="sm">Secondary</Button>
                <Button size="sm" variant="danger">Danger</Button>
              </div>
              <div className="flex gap-2 flex-wrap text-xs">
                <span className="px-1.5 rounded-sm" style={{ background: 'var(--chart-good)', color: '#fff' }}>success</span>
                <span className="px-1.5 rounded-sm" style={{ background: 'var(--chart-warn)', color: '#151515' }}>warning</span>
                <span className="px-1.5 rounded-sm" style={{ background: 'var(--chart-bad)', color: '#fff' }}>danger</span>
              </div>
              <pre className="text-xs rounded-sm p-2 font-mono" style={{ background: 'var(--os-code-bg)', color: 'var(--os-text-primary)' }}>{'$ oc get nodes\nnode-1  Ready'}</pre>
            </div>
          </div>
        </div>
      </div>
      {warnings.length > 0 && (
        <Note tone="warning" testId="custom-theme-warnings">
          <p className="font-medium mb-1">Low contrast (WCAG): the theme still saves</p>
          <ul className="list-disc pl-4 space-y-0.5">
            {warnings.map((w) => <li key={w.what}>{w.what}: {w.ratio}:1, under {w.min}:1</li>)}
          </ul>
        </Note>
      )}
      {footer}
    </div>
  );
}
