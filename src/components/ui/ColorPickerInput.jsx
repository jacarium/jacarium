/**
 * The colour picker: a swatch that opens the react-colorful picker in a
 * popover, with the hex value typed or pasted beside it - the Color
 * Converter tool's picker, shared (that tool and the theme editor use it).
 *
 *   <ColorPickerInput value="#7B5CE0" onChange={(hex) => ...} label="Accent" />
 *
 * `value` and the changes are '#rrggbb' strings (upper case from the
 * picker, whatever case is typed is passed on once it parses); an empty
 * value shows a blank swatch (`allowEmpty`: an optional colour, cleared with
 * the x). The popover closes on a click outside or Escape. Sizes: 'sm'
 * (a 28 px swatch and a short field, for a form) and 'lg' (the tool's big
 * swatch).
 */
import { useEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { TextInput, IconButton } from './primitives';
import { X } from 'lucide-react';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export default function ColorPickerInput({ value, onChange, label, size = 'sm', allowEmpty = false, testId, className = '', children }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || '');
  const [seen, setSeen] = useState(value);
  const ref = useRef(null);
  // a new value from outside (the picker, a reset): the field follows it
  if (seen !== value) { setSeen(value); setText(value || ''); }
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    // Escape closes the popover only (captured before the dialog behind it sees the key)
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const typed = (next) => {
    setText(next);
    const t = next.trim();
    if (HEX_RE.test(t)) onChange(t.length === 4 ? '#' + t.slice(1).split('').map((c) => c + c).join('') : t);
    else if (allowEmpty && t === '') onChange('');
  };
  const big = size === 'lg';
  const swatchClass = big
    ? 'w-32 h-32 rounded-sm border border-os-border shadow-lg cursor-pointer hover:border-os-blue transition-colors'
    : 'w-7 h-7 rounded-sm border border-os-input-border cursor-pointer hover:border-os-blue transition-colors shrink-0';
  return (
    <div className={`relative ${big ? 'flex items-start gap-4' : 'flex items-center gap-2'} ${className}`} ref={ref} data-testid={testId}>
      <button
        type="button"
        className={swatchClass}
        style={value ? { backgroundColor: value } : { backgroundImage: 'repeating-linear-gradient(45deg, var(--os-card-secondary) 0 6px, var(--os-card) 6px 12px)' }}
        onClick={() => setOpen((o) => !o)}
        title={label ? `${label}: pick a colour` : 'Pick a colour'}
        aria-label={label ? `${label}: pick a colour` : 'Pick a colour'}
        aria-expanded={open}
        data-testid={testId ? `${testId}-swatch` : undefined}
      />
      {open && (
        <div className={`absolute ${big ? 'top-full left-0 mt-2' : 'top-full left-0 mt-1'} z-50 p-3 bg-os-card border border-os-border rounded-sm shadow-lg`} role="dialog" aria-label={label ? `${label} picker` : 'Colour picker'}>
          <HexColorPicker color={value || '#000000'} onChange={(hex) => onChange(hex.toUpperCase())} />
        </div>
      )}
      {!big && (
        <TextInput
          mono
          size="sm"
          value={text}
          onChange={(e) => typed(e.target.value)}
          placeholder={allowEmpty ? 'same as above' : '#rrggbb'}
          aria-label={label ? `${label} (hex)` : 'Colour (hex)'}
          className="w-28"
          maxLength={7}
          spellCheck={false}
          data-testid={testId ? `${testId}-hex` : undefined}
        />
      )}
      {!big && allowEmpty && value && (
        <IconButton icon={X} label={`${label || 'Colour'}: clear`} size={14} onClick={() => onChange('')} />
      )}
      {children}
    </div>
  );
}
