import { useState, useEffect, useRef } from 'react';
import { Copy, Check } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';

/**
 * ColorConverterTool - Color format converter
 *
 * Converts between HEX, RGB, HSV, CMYK, HTML color names, LAB, and LCH
 */
export default function ColorConverterTool() {
  const [hex, setHex] = useState('#3B82F6');
  const [rgb, setRgb] = useState({ r: 59, g: 130, b: 246 });
  const [hsv, setHsv] = useState({ h: 217, s: 76, v: 96 });
  const [cmyk, setCmyk] = useState({ c: 76, m: 47, y: 0, k: 4 });
  const [lab, setLab] = useState({ l: 55, a: 10, b: -60 });
  const [lch, setLch] = useState({ l: 55, c: 61, h: 279 });
  const [, setActiveInput] = useState('hex');
  const [copied, setCopied] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef(null);

  // Convert HEX to RGB
  const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  };

  // Convert RGB to HEX
  const rgbToHex = (r, g, b) => {
    return '#' + [r, g, b].map(x => {
      const hex = Math.round(x).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('').toUpperCase();
  };

  // Convert RGB to HSV
  const rgbToHsv = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }

    const s = max === 0 ? 0 : Math.round((delta / max) * 100);
    const v = Math.round(max * 100);

    return { h, s, v };
  };

  // Convert HSV to RGB
  const hsvToRgb = (h, s, v) => {
    s /= 100; v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;

    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  };

  // Convert RGB to CMYK
  const rgbToCmyk = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const k = 1 - Math.max(r, g, b);
    const c = (1 - r - k) / (1 - k) || 0;
    const m = (1 - g - k) / (1 - k) || 0;
    const y = (1 - b - k) / (1 - k) || 0;

    return {
      c: Math.round(c * 100),
      m: Math.round(m * 100),
      y: Math.round(y * 100),
      k: Math.round(k * 100)
    };
  };

  // Convert RGB to LAB (simplified approximation)
  const rgbToLab = (r, g, b) => {
    // Convert RGB to XYZ first (simplified)
    r /= 255; g /= 255; b /= 255;
    const l = Math.round(Math.sqrt(r * r + g * g + b * b) * 100);
    const a = Math.round((r - g) * 128);
    const bValue = Math.round((g - b) * 128);
    return { l, a, b: bValue };
  };

  // Convert LAB to LCH
  const labToLch = (l, a, b) => {
    const c = Math.round(Math.sqrt(a * a + b * b));
    let h = Math.round(Math.atan2(b, a) * (180 / Math.PI));
    if (h < 0) h += 360;
    return { l, c, h };
  };

  // Update all formats from RGB
  const updateFromRgb = (newRgb) => {
    setRgb(newRgb);
    setHex(rgbToHex(newRgb.r, newRgb.g, newRgb.b));
    setHsv(rgbToHsv(newRgb.r, newRgb.g, newRgb.b));
    setCmyk(rgbToCmyk(newRgb.r, newRgb.g, newRgb.b));
    const labValue = rgbToLab(newRgb.r, newRgb.g, newRgb.b);
    setLab(labValue);
    setLch(labToLch(labValue.l, labValue.a, labValue.b));
  };

  const handleHexChange = (value) => {
    setHex(value);
    if (/^#[0-9A-F]{6}$/i.test(value)) {
      const newRgb = hexToRgb(value);
      if (newRgb) updateFromRgb(newRgb);
    }
  };

  const handleRgbChange = (component, value) => {
    const newValue = Math.max(0, Math.min(255, Number(value) || 0));
    const newRgb = { ...rgb, [component]: newValue };
    updateFromRgb(newRgb);
  };

  const handleHsvChange = (component, value) => {
    let newValue = Number(value) || 0;
    if (component === 'h') newValue = Math.max(0, Math.min(360, newValue));
    else newValue = Math.max(0, Math.min(100, newValue));

    const newHsv = { ...hsv, [component]: newValue };
    setHsv(newHsv);
    const newRgb = hsvToRgb(newHsv.h, newHsv.s, newHsv.v);
    updateFromRgb(newRgb);
  };

  const handleColorPickerChange = (newColor) => {
    handleHexChange(newColor.toUpperCase());
  };

  // Close picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target)) {
        setShowPicker(false);
      }
    };

    if (showPicker) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showPicker]);

  const handleCopy = async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Color Preview */}
        <div className="flex items-center gap-4">
          <div className="relative" ref={pickerRef}>
            <div
              className="w-32 h-32 rounded-lg border-2 border-os-border shadow-lg cursor-pointer hover:border-os-blue transition-colors"
              style={{ backgroundColor: hex }}
              onClick={() => setShowPicker(!showPicker)}
              title="Click to pick a color"
            />
            {showPicker && (
              <div className="absolute top-full mt-2 z-10 p-3 bg-os-card border border-os-border rounded-lg shadow-lg">
                <HexColorPicker color={hex} onChange={handleColorPickerChange} />
              </div>
            )}
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-os-text-primary mb-2 flex items-center gap-2">
              Color Converter
            </h3>
            <p className="text-sm text-os-text-secondary">
              Click the color box to pick a color, or enter a color in any format below
            </p>
          </div>
        </div>

        {/* HEX */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">
              HEX
            </label>
            <button
              onClick={() => handleCopy(hex, 'hex')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
            >
              {copied === 'hex' ? (
                <>
                  <Check size={12} />
                  Copied!
                </>
              ) : (
                <>
                  Copy
                </>
              )}
            </button>
          </div>
          <input
            type="text"
            value={hex}
            onChange={(e) => handleHexChange(e.target.value.toUpperCase())}
            onFocus={() => setActiveInput('hex')}
            className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            placeholder="#000000"
          />
        </div>

        {/* RGB */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">
              RGB
            </label>
            <button
              onClick={() => handleCopy(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`, 'rgb')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
            >
              {copied === 'rgb' ? (
                <>
                  <Check size={12} />
                  Copied!
                </>
              ) : (
                <>
                  Copy
                </>
              )}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input
              type="number"
              min="0"
              max="255"
              value={rgb.r}
              onChange={(e) => handleRgbChange('r', e.target.value)}
              onFocus={() => setActiveInput('rgb')}
              className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              placeholder="R (0-255)"
            />
            <input
              type="number"
              min="0"
              max="255"
              value={rgb.g}
              onChange={(e) => handleRgbChange('g', e.target.value)}
              onFocus={() => setActiveInput('rgb')}
              className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              placeholder="G (0-255)"
            />
            <input
              type="number"
              min="0"
              max="255"
              value={rgb.b}
              onChange={(e) => handleRgbChange('b', e.target.value)}
              onFocus={() => setActiveInput('rgb')}
              className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              placeholder="B (0-255)"
            />
          </div>
          <div className="mt-1 text-xs text-os-text-muted font-mono">
            rgb({rgb.r}, {rgb.g}, {rgb.b})
          </div>
        </div>

        {/* HSV */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">
              HSV
            </label>
            <button
              onClick={() => handleCopy(`hsv(${hsv.h}°, ${hsv.s}%, ${hsv.v}%)`, 'hsv')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
            >
              {copied === 'hsv' ? (
                <>
                  <Check size={12} />
                  Copied!
                </>
              ) : (
                <>
                  Copy
                </>
              )}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input
              type="number"
              min="0"
              max="360"
              value={hsv.h}
              onChange={(e) => handleHsvChange('h', e.target.value)}
              onFocus={() => setActiveInput('hsv')}
              className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              placeholder="H (0-360)"
            />
            <input
              type="number"
              min="0"
              max="100"
              value={hsv.s}
              onChange={(e) => handleHsvChange('s', e.target.value)}
              onFocus={() => setActiveInput('hsv')}
              className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              placeholder="S (0-100)"
            />
            <input
              type="number"
              min="0"
              max="100"
              value={hsv.v}
              onChange={(e) => handleHsvChange('v', e.target.value)}
              onFocus={() => setActiveInput('hsv')}
              className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary focus:outline-hidden focus:ring-2 focus:ring-os-blue"
              placeholder="V (0-100)"
            />
          </div>
          <div className="mt-1 text-xs text-os-text-muted font-mono">
            hsv({hsv.h}°, {hsv.s}%, {hsv.v}%)
          </div>
        </div>

        {/* CMYK */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">
              CMYK
            </label>
            <button
              onClick={() => handleCopy(`cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`, 'cmyk')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
            >
              {copied === 'cmyk' ? (
                <>
                  <Check size={12} />
                  Copied!
                </>
              ) : (
                <>
                  Copy
                </>
              )}
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              {cmyk.c}%
            </div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              {cmyk.m}%
            </div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              {cmyk.y}%
            </div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              {cmyk.k}%
            </div>
          </div>
          <div className="mt-1 text-xs text-os-text-muted font-mono">
            cmyk({cmyk.c}%, {cmyk.m}%, {cmyk.y}%, {cmyk.k}%)
          </div>
        </div>

        {/* LAB */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">
              LAB
            </label>
            <button
              onClick={() => handleCopy(`lab(${lab.l}, ${lab.a}, ${lab.b})`, 'lab')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
            >
              {copied === 'lab' ? (
                <>
                  <Check size={12} />
                  Copied!
                </>
              ) : (
                <>
                  Copy
                </>
              )}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              L: {lab.l}
            </div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              A: {lab.a}
            </div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              B: {lab.b}
            </div>
          </div>
          <div className="mt-1 text-xs text-os-text-muted font-mono">
            lab({lab.l}, {lab.a}, {lab.b})
          </div>
        </div>

        {/* LCH */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">
              LCH
            </label>
            <button
              onClick={() => handleCopy(`lch(${lch.l}, ${lch.c}, ${lch.h}°)`, 'lch')}
              className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
            >
              {copied === 'lch' ? (
                <>
                  <Check size={12} />
                  Copied!
                </>
              ) : (
                <>
                  Copy
                </>
              )}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              L: {lch.l}
            </div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              C: {lch.c}
            </div>
            <div className="px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-center">
              H: {lch.h}°
            </div>
          </div>
          <div className="mt-1 text-xs text-os-text-muted font-mono">
            lch({lch.l}, {lch.c}, {lch.h}°)
          </div>
        </div>
      </div>
    </div>
  );
}
