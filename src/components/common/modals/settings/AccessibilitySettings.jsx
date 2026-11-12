import { useRef, useState } from 'react';
import { Button, ButtonRow, Field, Note, RangeInput, Section, Segmented, Select, Toggle } from './ui';
import ReadingAidsSurface, { useReadingAids, useZenMode } from '../../ReadingAidsSurface';
import ProfileGallery from './ProfileGallery';
import { applyProfile, profileState } from '../../../../utils/readingAidProfiles';
import {
  CODE_FONTS, COLOR_VISIONS, LETTER_SPACING_MAX, LINE_HEIGHTS, LINE_WIDTHS, PARAGRAPH_SPACINGS, READING_FONTS, RULER_LINES,
  SATURATION_MIN, SCOPE_LABELS, TEXT_SCALES, TEXT_SCALE_MAX, TEXT_SCALE_MIN, TEXT_SCALE_STEP, WORD_SPACING_MAX, applyAppReadingAids, isDefaultReadingAids, resetReadingAids, saveReadingAids, snapTextScale, zenMode,
} from '../../../../utils/readingAids';

const LINE_HEIGHT_LABELS = { 0: 'Default', 1.8: 'Relaxed (1.8)', 2: 'Loose (2.0)', 2.4: 'Airy (2.4)' };
const PARAGRAPH_LABELS = { 0: 'Default', 1.5: 'More (1.5 lines)', 2: 'Double (2 lines)', 3: 'Wide (3 lines)' };
const COLOR_VISION_LABELS = { none: 'Off', protanopia: 'Protanopia (red-weak)', deuteranopia: 'Deuteranopia (green-weak)', tritanopia: 'Tritanopia (blue-weak)' };
// the sample the settings show: a heading, paragraphs with a link and inline code, a list, a short code block
const SAMPLE_HTML = '<h3>Reading sample</h3><p>The quick brown fox jumps over the lazy dog, then reads <a href="#sample" onclick="return false">the runbook</a> and types <code>oc get nodes</code> before the standup. A second sentence makes the paragraph long enough to wrap on a narrow pane, so the ruler has lines to follow.</p><p>A second paragraph, so the spacing between paragraphs shows, and the ruler has a neighbour to mask.</p><ul><li>a list item with a few words</li><li>another one, a little longer than the first</li></ul><pre><code class="hljs language-bash"><span class="hljs-built_in">echo</span> <span class="hljs-string">"hello"</span></code></pre>';

const Group = ({ scope, hint, children }) => (
  <div className="space-y-3" data-testid={`ra-group-${scope}`}>
    <div>
      <p className="text-xs font-medium text-os-text-primary">{SCOPE_LABELS[scope]}</p>
      <p className="text-xs text-os-text-secondary">{hint}</p>
    </div>
    {children}
  </div>
);

/**
 * Settings > Accessibility: the reading aids (src/utils/readingAids.js),
 * in three groups by where they apply - everywhere, reading text
 * everywhere, the Documents editor and Preview only. Applied at once to
 * everything open; stored on this device, like the editor's spell checking.
 * The sample at the end is a reading area of its own, so every option -
 * the ruler included - shows there.
 */
export default function AccessibilitySettings() {
  const settings = useReadingAids();
  const zen = useZenMode();
  const [sampleOpen, setSampleOpen] = useState(true);
  const set = (patch) => saveReadingAids(patch);
  // the text-size slider: live while it moves (one application per animation frame, straight onto <html>), stored
  // when it is released or a key is let go (and after a short pause, should no release come)
  const [scaleDraft, setScaleDraft] = useState(null);
  const scaleRaf = useRef(0);
  const scaleTimer = useRef(0);
  const commitScale = (v) => { clearTimeout(scaleTimer.current); setScaleDraft(null); set({ textScale: v }); };
  const previewScale = (v) => {
    setScaleDraft(v);
    if (!scaleRaf.current) scaleRaf.current = requestAnimationFrame(() => { scaleRaf.current = 0; applyAppReadingAids({ ...settings, textScale: v }); });
    clearTimeout(scaleTimer.current);
    scaleTimer.current = setTimeout(() => commitScale(v), 400);
  };
  const textScale = scaleDraft ?? settings.textScale;
  const asDefault = isDefaultReadingAids(settings);
  return (
    <Section title="Accessibility" description="Reading aids for the whole app, on this device. They change how things are shown here, never the content: documents, exports, sync and other readers see everything as it is." testId="accessibility-section">
      <div className="space-y-2" data-testid="ra-profiles-block">
        <div>
          <p className="text-xs font-medium text-os-text-primary">Profiles</p>
          <p className="text-xs text-os-text-secondary">A quick start: a profile sets every option below at once (the ones it names, the rest back to default). Adjust anything afterwards.</p>
        </div>
        <ProfileGallery {...profileState(settings)} onSelect={(id) => applyProfile(id)} />
      </div>

      <Group scope="app" hint="Colour, contrast, links and images: the whole window, dialogs, menus and the rail included.">
        <div className="space-y-2">
          <Toggle label="High contrast" hint="Black on white in a light theme, white on black in a dark one - text, borders, buttons, links, code and the status colours at 7:1 or better, whatever the theme." checked={settings.highContrast} onChange={(highContrast) => set({ highContrast })} testId="ra-high-contrast" />
          <Toggle label="Greyscale" hint="Everything in greys." checked={settings.greyscale} onChange={(greyscale) => set({ greyscale })} testId="ra-greyscale" />
          <Toggle label="Highlighted links" hint="Every text link underlined, on a tint, so links stand apart from the text - in documents, chat, descriptions, reports and settings." checked={settings.highlightLinks} onChange={(highlightLinks) => set({ highlightLinks })} testId="ra-links" />
          <Toggle label="Hide images" hint="Where your content shows images (documents, chat, descriptions): a placeholder with the image's alt text and a Show image button takes each image's place." checked={settings.hideImages} onChange={(hideImages) => set({ hideImages })} testId="ra-hide-images" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Colour-vision palette" htmlFor="ra-color-vision" hint="Links, the accent, the status and severity colours, syntax colours and callouts from a palette told apart with that kind of colour vision (Okabe-Ito); good, warning and bad differ in lightness too.">
            <Select id="ra-color-vision" value={settings.colorVision} onChange={(e) => set({ colorVision: e.target.value })} data-testid="ra-color-vision">
              {COLOR_VISIONS.map((v) => <option key={v} value={v}>{COLOR_VISION_LABELS[v]}</option>)}
            </Select>
          </Field>
          <Field label="Reduce motion" hint="Animation and movement everywhere - sidebars and panels sliding, dialogs and toasts appearing, spinners and skeletons, hover effects, smooth scrolling, charts drawing - replaced by instant changes. Follow system takes the setting from the OS (Reduce motion on macOS, Animation effects on Windows, GNOME's Animations); On and Off override it on this device.">
            <Segmented value={settings.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} testId="ra-reduce-motion" options={[{ id: 'system', label: 'Follow system' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]} />
          </Field>
          <Field label="Saturation" htmlFor="ra-saturation" hint="Less colour everywhere; greyscale above takes it all away.">
            <RangeInput id="ra-saturation" min={SATURATION_MIN} max={100} step={5} value={settings.saturation} disabled={settings.greyscale} onChange={(v) => set({ saturation: v })} format={(v) => (v === 100 ? 'Full' : `${v} %`)} testId="ra-saturation" />
          </Field>
        </div>
      </Group>

      <Group scope="reading" hint="Body copy, descriptions, chat messages, report text, dialogs, toasts and the document editor - never code, logs, terminals, fixed-width output or chart labels. Controls (labels, buttons, fields, tabs, the rail) keep their sizes.">
        <Field label="Reading font" htmlFor="ra-font" hint="Atkinson Hyperlegible, Lexend and OpenDyslexic ship with the app (SIL Open Font License), so they work offline; a font loads the first time it is chosen. Code keeps its own font.">
          <Select id="ra-font" value={settings.font} onChange={(e) => set({ font: e.target.value })} data-testid="ra-font">
            {Object.entries(READING_FONTS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
          </Select>
        </Field>
        <Field label="Code font" htmlFor="ra-code-font" hint="Monospaced fonts designed to tell similar characters apart (0/O, 1/l/I). Code stays aligned. For code blocks and inline code, the editor's code and line numbers, logs, terminals and the Diagnostics report's monospace parts; ships with the app (SIL Open Font License) and loads the first time it is chosen.">
          <Select id="ra-code-font" value={settings.codeFont} onChange={(e) => set({ codeFont: e.target.value })} data-testid="ra-code-font">
            {Object.entries(CODE_FONTS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Letter spacing" htmlFor="ra-letter-spacing">
            <RangeInput id="ra-letter-spacing" min={0} max={LETTER_SPACING_MAX} step={0.01} value={settings.letterSpacing} onChange={(v) => set({ letterSpacing: v })} format={(v) => (v ? `${v.toFixed(2)} em` : 'Default')} testId="ra-letter-spacing" />
          </Field>
          <Field label="Word spacing" htmlFor="ra-word-spacing">
            <RangeInput id="ra-word-spacing" min={0} max={WORD_SPACING_MAX} step={0.05} value={settings.wordSpacing} onChange={(v) => set({ wordSpacing: v })} format={(v) => (v ? `${v.toFixed(2)} em` : 'Default')} testId="ra-word-spacing" />
          </Field>
          <Field label="Line height" htmlFor="ra-line-height" hint="in reading areas: documents, chat messages, report text">
            <Select id="ra-line-height" value={String(settings.lineHeight)} onChange={(e) => set({ lineHeight: Number(e.target.value) })} data-testid="ra-line-height">
              {LINE_HEIGHTS.map((v) => <option key={v} value={String(v)}>{LINE_HEIGHT_LABELS[v]}</option>)}
            </Select>
          </Field>
          <Field label="Paragraph spacing" htmlFor="ra-paragraph-spacing" hint="the space after a paragraph in reading areas">
            <Select id="ra-paragraph-spacing" value={String(settings.paragraphSpacing)} onChange={(e) => set({ paragraphSpacing: Number(e.target.value) })} data-testid="ra-paragraph-spacing">
              {PARAGRAPH_SPACINGS.map((v) => <option key={v} value={String(v)}>{PARAGRAPH_LABELS[v]}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Text size" hint="Scales the reading text - documents, chat, descriptions, reports - and their code and logs with it, in their own fonts. Separate from the desktop app's zoom (⌘+ / ⌘− / ⌘0), which scales the whole window; the two multiply." htmlFor="ra-text-scale">
          <RangeInput id="ra-text-scale" min={TEXT_SCALE_MIN} max={TEXT_SCALE_MAX} step={TEXT_SCALE_STEP} pageStep={25} value={textScale} onChange={(v) => previewScale(snapTextScale(v))} onCommit={(v) => commitScale(snapTextScale(v))} format={(v) => `${Number.isInteger(v) ? v : v.toFixed(1)} %`} marks={TEXT_SCALES.map((v) => ({ value: v, label: v === 100 ? 'Default' : `${v} %` }))} testId="ra-text-scale" />
          {textScale !== 100 && (
            <ButtonRow align="start" className="mt-1">
              <Button size="sm" variant="ghost" onClick={() => commitScale(100)} data-testid="ra-text-scale-reset">Back to 100 %</Button>
            </ButtonRow>
          )}
        </Field>
        <Toggle label="Scale the interface too" hint="Buttons, menus, tabs, the sidebars and the rail follow the text size (the reading text then takes its size from them). Off, only the reading text grows and the controls stay where they are." checked={settings.scaleChrome} disabled={settings.textScale === 100} onChange={(scaleChrome) => set({ scaleChrome })} testId="ra-scale-chrome" />
        <Toggle label="Reading ruler" hint="A band that follows the line you're reading - under the pointer, or the caret in the editor; with the text focused, ↑ and ↓ move it. Mask dims the rest." checked={settings.ruler} onChange={(ruler) => set({ ruler })} testId="ra-ruler" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Band height">
            <Segmented value={String(settings.rulerLines)} onChange={(v) => set({ rulerLines: Number(v) })} testId="ra-ruler-lines" options={RULER_LINES.map((n) => ({ id: String(n), label: n === 1 ? '1 line' : `${n} lines` }))} />
          </Field>
          <Field label="Ruler style">
            <Segmented value={settings.rulerMode} onChange={(rulerMode) => set({ rulerMode })} testId="ra-ruler-mode" options={[{ id: 'highlight', label: 'Highlight' }, { id: 'mask', label: 'Mask' }]} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Line width" htmlFor="ra-line-width" hint="long-form text: centred in Documents, capped elsewhere (chat, descriptions, dialogs)">
            <Select id="ra-line-width" value={String(settings.lineWidth)} onChange={(e) => set({ lineWidth: Number(e.target.value) })} data-testid="ra-line-width">
              {LINE_WIDTHS.map((v) => <option key={v} value={String(v)}>{v ? `${v} characters` : 'Off (the pane\'s width)'}</option>)}
            </Select>
          </Field>
          <Field label="Text alignment" hint="Long-form text only. Left-aligned text is easier for many dyslexic readers: the gaps of justified text form rivers down the page.">
            <Segmented value={settings.textAlign} onChange={(textAlign) => set({ textAlign })} testId="ra-text-align" options={[{ id: 'left', label: 'Left' }, { id: 'justify', label: 'Justified' }, { id: 'justify-hyphens', label: 'Justified, hyphenated' }]} />
          </Field>
        </div>
        <Field label="Zen mode" hint="On every page: hides the rail, the page's sidebar and the panels and leaves the page's main content; the slim pull-out tabs at the middle of the window's edges (and the shortcuts Show sidebar / sections and Show navigation, Settings > Shortcuts > Reading) open the page's sidebar on the left and Navigation - the pages and the panels - on the right as overlays; what you open or close there is for the moment, the layout comes back as it was when zen ends. Documents centres the document. Esc, the same shortcut, or the Zen label in the bottom-right corner leaves it. A mode of the moment: it is not remembered.">
          <ButtonRow align="start">
            <Button size="sm" onClick={() => zenMode.toggle()} data-testid="ra-zen" aria-pressed={zen}>{zen ? 'Leave zen mode' : 'Enter zen mode'}</Button>
          </ButtonRow>
        </Field>
      </Group>

      <ButtonRow align="start">
        <Button size="sm" onClick={() => resetReadingAids()} disabled={asDefault} data-testid="ra-reset">Reset to defaults</Button>
        <Button size="sm" variant="ghost" onClick={() => setSampleOpen((o) => !o)} aria-expanded={sampleOpen} aria-controls="ra-sample" data-testid="ra-sample-toggle">{sampleOpen ? 'Hide the sample' : 'Show the sample'}</Button>
      </ButtonRow>
      {sampleOpen && (
        <div id="ra-sample">
          <p className="text-xs text-os-text-secondary mb-2">How a document reads with these choices (the ruler follows the pointer here too):</p>
          <ReadingAidsSurface settings={settings} className="rounded-sm border border-os-border overflow-hidden" testId="ra-sample">
            {/* the sample is the app's own markup (no user content) */}
            <div className="markdown-preview px-6 py-4 bg-os-card text-sm" data-testid="ra-sample-preview" tabIndex={0} dangerouslySetInnerHTML={{ __html: SAMPLE_HTML }} />
          </ReadingAidsSurface>
        </div>
      )}
      {!asDefault && <Note tone="info" testId="ra-active-note">Reading aids are on for this device. Reset to defaults puts everything back.</Note>}
      <Note testId="ra-scope-note">Stored on this device only (like the editor&apos;s spell checking): these choices depend on the screen, the fonts and the eyes in front of it. Shortcuts for zen mode, the ruler, high contrast, greyscale, hidden images and highlighted links are in Settings &gt; Shortcuts.</Note>
    </Section>
  );
}
