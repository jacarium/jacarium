import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import FloatingWindow from './common/FloatingWindow';
import BrandMark from '../brand/BrandMark';
import { Button } from './ui';
import { versions, latestVersion } from '../whats-new/versions';
import { groupFeaturesByCategory, majorLinesOf, compareVersions } from '../whats-new/categories';

// The version shown is the newest entry in src/whats-new/versions (which the
// release steps keep equal to package.json - see tests/app-version-consistency)
const APP_VERSION = latestVersion;

/** localStorage key of the last version whose What's New was dismissed. */
export const WHATS_NEW_SEEN_KEY = 'whatsNewLastSeen';

// Carousel component for rotating images (older entries use it)
function ImageCarousel({ images }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState(true);

  // Auto-advance carousel every 3 seconds
  useEffect(() => {
    if (!isAutoPlaying || images.length <= 1) return undefined;
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % images.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [currentIndex, isAutoPlaying, images.length]);

  const goToPrevious = () => {
    setIsAutoPlaying(false);
    setCurrentIndex((prev) => (prev - 1 + images.length) % images.length);
  };
  const goToNext = () => {
    setIsAutoPlaying(false);
    setCurrentIndex((prev) => (prev + 1) % images.length);
  };
  const goToSlide = (index) => {
    setIsAutoPlaying(false);
    setCurrentIndex(index);
  };

  if (!images || images.length === 0) return null;

  return (
    <div className="relative group rounded-sm border border-os-border overflow-hidden">
      <img src={images[currentIndex].src} alt={images[currentIndex].alt} className="w-full h-auto" />
      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={goToPrevious}
            className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 hover:bg-black/70 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Previous image"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            onClick={goToNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/50 hover:bg-black/70 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Next image"
          >
            <ChevronRight size={20} />
          </button>
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
            {images.map((_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => goToSlide(index)}
                className={`w-2 h-2 rounded-full transition-all ${index === currentIndex ?'bg-os-card w-4':'bg-white/50 hover:bg-white/75'}`}
                aria-label={`Image ${index + 1}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** One content block of a feature: text paragraph, image, carousel or a compact list. */
function ContentBlock({ block, feature }) {
  if (block.type === 'text') {
    return <p className="text-xs text-os-text-secondary leading-relaxed">{block.value}</p>;
  }
  if (block.type === 'image') {
    return (
      <div className="rounded-sm border border-os-border overflow-hidden">
        <img src={block.src} alt={block.alt || feature.title || ''} className="w-full h-auto" />
      </div>
    );
  }
  if (block.type === 'carousel') {
    return <ImageCarousel images={block.images} />;
  }
  if (block.type === 'list') {
    return (
      <ul className="list-disc pl-5 space-y-1 text-xs text-os-text-secondary leading-relaxed" data-whats-new-list="true">
        {block.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    );
  }
  return null;
}

/** The tag-style heading of a category group: [DOCUMENTS], [SECURITY], ... */
function CategoryTag({ category }) {
  return (
    <h3
      data-whats-new-category={category}
      className="inline-flex items-center font-mono text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm border border-os-border bg-os-card-secondary text-os-text-secondary"
    >
      [{category}]
    </h3>
  );
}

/**
 * One version of the list: its header (number, release date, "New" while it
 * is newer than the last version seen) and its changes grouped by category.
 */
function VersionSection({ entry, current, unseen, first }) {
  const groups = useMemo(() => groupFeaturesByCategory(entry.features), [entry]);
  // Versions are separated by ONE rule: a top border on every section but the
  // first (no bottom borders, so nothing doubles up with the block below).
  return (
    <section
      data-whats-new-version={entry.version}
      data-whats-new-unseen={unseen ? 'true' : undefined}
      aria-labelledby={`whats-new-version-${entry.version}`}
      className={first ? '' : 'pt-5 mt-5 border-t border-os-border'}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-3">
        <h2 id={`whats-new-version-${entry.version}`} className="text-sm font-semibold text-os-text-primary">
          Version {entry.version}
        </h2>
        {entry.date && <time dateTime={entry.date} data-whats-new-date="true" className="text-xs text-os-text-secondary">{entry.date}</time>}
        {current && <span className="text-[10px] uppercase tracking-wide text-os-text-secondary">current</span>}
        {unseen && !current && <span data-whats-new-new-badge="true" className="text-[10px] uppercase tracking-wide px-1 rounded-sm bg-os-blue text-white">new</span>}
      </div>
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.category} data-whats-new-group={group.category} className="space-y-2">
            <CategoryTag category={group.category} />
            <div className="space-y-3 ml-1">
              {group.features.map((feature) => (
                <div key={`${entry.version}-${feature.id}`} className="space-y-2">
                  {feature.title && <h4 className="text-xs font-semibold text-os-text-primary">{feature.title}</h4>}
                  {feature.content.map((block, index) => (
                    <ContentBlock key={index} block={block} feature={feature} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * WhatsNew - the release notes window, on the shared FloatingWindow chrome
 * (same look as Find in Files: draggable, resizable, os-* tokens).
 *
 * Opens by itself the first time a new version runs (localStorage
 * WHATS_NEW_SEEN_KEY != latest version), on the `toggleWhatsNew` window
 * event and on Electron's "show What's New" menu action. Closing it (x,
 * Escape, "Got it!") marks the current version as seen.
 *
 * The content is ONE scrollable list of the current major line (3.x):
 * newest version first, each with its number and release date, its changes
 * grouped by category under tag-style headings ([DOCUMENTS], [SECURITY],
 * ... MISC last - src/whats-new/categories.js). Versions newer than the
 * last one seen carry a "new" badge. At the end of the list, buttons switch
 * to the older lines ("Version 2.x", ...), each shown the same way, with a
 * way back; every reopen starts at the current line again.
 */
export default function WhatsNew() {
  const [isOpen, setIsOpen] = useState(() => {
    const lastSeenVersion = localStorage.getItem(WHATS_NEW_SEEN_KEY);
    return !lastSeenVersion || lastSeenVersion !== APP_VERSION;
  });
  // the version seen before this window opened: everything newer is "new"
  const [lastSeen, setLastSeen] = useState(() => localStorage.getItem(WHATS_NEW_SEEN_KEY) || null);
  const lines = useMemo(() => majorLinesOf(versions), []);
  const currentLine = String(APP_VERSION).split('.')[0];
  const [activeLine, setActiveLine] = useState(currentLine);
  const shown = useMemo(() => versions.filter((v) => String(v.version).split('.')[0] === activeLine), [activeLine]);
  const olderLines = lines.filter((line) => Number(line) < Number(activeLine));

  // Listen for toggle event
  useEffect(() => {
    function handleToggle() {
      setIsOpen((prev) => !prev);
    }
    window.addEventListener('toggleWhatsNew', handleToggle);
    return () => window.removeEventListener('toggleWhatsNew', handleToggle);
  }, []);

  // Listen for Electron IPC event to show What's New
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.onShowWhatsNew) {
      const unsubscribe = window.electronAPI.onShowWhatsNew(() => {
        setIsOpen(true);
      });
      return () => {
        if (unsubscribe) unsubscribe();
      };
    }
    return undefined;
  }, []);

  // Broadcast state changes
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('whatsNewStateChange', { detail: { isOpen } }));
  }, [isOpen]);

  function handleClose() {
    // Mark current version as seen
    localStorage.setItem(WHATS_NEW_SEEN_KEY, APP_VERSION);
    setLastSeen(APP_VERSION);
    setIsOpen(false);
    // The next open starts at the current line again (the choice is not persisted)
    setActiveLine(currentLine);
  }

  const isUnseen = (version) => !!lastSeen && compareVersions(version, lastSeen) > 0;

  return (
    <FloatingWindow
      open={isOpen}
      onClose={handleClose}
      title="What's New"
      icon={<BrandMark size={18} />}
      storageKey="whatsNewWindow"
      defaultSize={{ width: 720, height: 620 }}
      minWidth={420}
      minHeight={320}
    >
      <div className="flex flex-col h-full min-h-0" data-whats-new="true">
        {/* Scrollable content: every version of the active line, newest first. Keyed on
            the line so a switch mounts a fresh container (scrolled to the top). */}
        <div
          key={activeLine}
          tabIndex={0}
          role="region"
          aria-label={`Release notes, version ${activeLine}.x`}
          className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-os-blue/40"
          data-whats-new-content="true"
          data-whats-new-line={activeLine}
        >
          {activeLine !== currentLine && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-os-text-secondary">Version {activeLine}.x - older releases</p>
              <Button size="sm" onClick={() => setActiveLine(currentLine)} data-whats-new-line-switch={currentLine}>
                Back to version {currentLine}.x
              </Button>
            </div>
          )}
          {shown.map((entry, index) => (
            <VersionSection key={entry.version} entry={entry} current={entry.version === APP_VERSION} unseen={isUnseen(entry.version)} first={index === 0} />
          ))}
          {/* One closing block after the last version, behind ONE rule: the
              older lines (when there are any) and the thank-you line. */}
          <div className="mt-6 pt-4 border-t border-os-border space-y-4" data-whats-new-closing="true">
            {olderLines.length > 0 && (
              <div className="flex flex-wrap items-center gap-2" data-whats-new-older-lines="true">
                <p className="text-xs text-os-text-secondary">Older releases:</p>
                {olderLines.map((line) => (
                  <Button key={line} size="sm" onClick={() => setActiveLine(line)} data-whats-new-line-switch={line}>
                    Version {line}.x
                  </Button>
                ))}
              </div>
            )}
            <p className="text-xs text-os-text-secondary text-center">Thank you for using Jacarium!</p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-os-border flex justify-end shrink-0">
          <Button variant="primary" onClick={handleClose} data-whats-new-close="true">Got it!</Button>
        </div>
      </div>
    </FloatingWindow>
  );
}
