# What's New

Release notes shown by the in-app "What's New" window
(`src/components/WhatsNew.jsx`) and in the repository's `CHANGELOG.md`.
Everything is local and offline: no remote, no tags are pushed, nothing is
published.

## How to release

```bash
npm run release              # next patch; --minor / --major; or an explicit one: npm run release -- 3.5.0
# review src/whats-new/versions/vX.Y.Z.js, tidy the lines if you like
npm run release:tag          # commit "Release vX.Y.Z" and create the local annotated tag vX.Y.Z
```

Versions follow Semantic Versioning (semver.org), with no upper limit on any
part: `npm run release` steps the patch (3.4.9 → 3.4.10), `--minor` the minor
(3.4.7 → 3.5.0), `--major` the major (4.0.0). An explicit version must be
greater than the current one.

`npm run release` needs a clean working tree. It bumps `package.json` and
`package-lock.json`, writes the new entry from `git log <previous release>..HEAD`
(one line per commit subject, grouped by category - see below; merge commits
and "Release"/"Bump version"/"Baseline snapshot" commits are left out and
listed), adds it to `versions/index.js` and `versions/changelog.json`,
regenerates `CHANGELOG.md` (one section per version), prints a summary (every
line with its category and what decided it) and asks whether to tag right
away. Answer `n` to review first, then `npm run release:tag`. The
previous release is the tag `v<current version>`, or - when no tag exists yet -
the commit that set the current version in `package.json`.
`npm run release -- --dry-run` shows the summary and the generated entry
without writing anything.

The window opens by itself once per version (localStorage `whatsNewLastSeen`),
from the Help menu, and on the `toggleWhatsNew` window event. It shows ONE
scrollable list of the current major line (3.x): newest version first, each
with its number and release date and its changes grouped by category under
tag-style headings; versions newer than the last one seen carry a "new"
badge; buttons at the end switch to the older lines ("Version 2.x").

## Categories

`categories.js` lists them in the fixed order the window and `CHANGELOG.md` use:
DOCUMENTS, TASKS, KANBAN, WORKFLOWS, CALENDAR, JIRA, AI, DIAGNOSTICS, TEAM
(central server, collaboration, games), SYNC (home server), SECURITY,
SETTINGS, UI, DESKTOP, DEPLOY, TESTS, MISC (last). `scripts/whats-new-from-git.cjs`
gives each commit one, in this order:

1. an explicit `[CATEGORY] ` prefix on the commit subject (stripped from the
   shown line), or an entry in the script's `OVERRIDES` map (sha prefix or
   exact subject);
2. the files it touched (`PATH_RULES`: e.g. `src/sync/**` → SYNC,
   `jacarium-central/**` → TEAM, `deploy/**` → DEPLOY; the category with the
   most files wins; a commit touching only `tests/` is TESTS; README, the
   lock files and the What's New data never decide; an app-wide sweep across
   three or more areas with no majority falls through to the subject);
3. keywords in the subject (`KEYWORD_RULES`);
4. MISC.

Each change appears exactly once. The hand-written 2.x entries keep their
titles and got a category from the same keyword rules (with overrides).

## File structure

```
src/whats-new/
├── versions/
│   ├── index.js           # Exports all versions (newest first)
│   ├── changelog.json     # Text-only changelog, source of CHANGELOG.md
│   ├── v3.1.3.js          # Generated entry (one `list` block per category)
│   ├── v2.5.5.js          # Hand-written entry (titled features, each with a category)
│   └── ...
├── categories.js          # The fixed category order and the grouping helpers
├── features.js            # Deprecated shim (re-exports the latest features)
└── README.md              # This file
scripts/release.cjs            # the release command
scripts/whats-new-from-git.cjs # the notes generator (used by release.cjs;
                               #   node scripts/whats-new-from-git.cjs <from> <version> --force
                               #   regenerates one entry by hand)
```

## Entry format

```javascript
export const version = '2.7.0';
export const date = '2026-10-14';     // the release date (the newest commit's), or null

export const features = [
  {
    id: 1,
    category: 'DOCUMENTS',            // one of categories.js (anything else renders under MISC)
    title: 'Optional title',          // hand-written entries only; generated ones have none
    content: [
      { type: 'text', value: 'A paragraph.' },
      { type: 'list', items: ['One line', 'Another line'] },   // compact bullet list
      { type: 'image', src: importedImage, alt: 'Screenshot' },
      { type: 'carousel', images: [{ src: image1, alt: 'First' }, { src: image2, alt: 'Second' }] },
    ]
  }
];
```

The window still renders `image` and `carousel` blocks, but no entry ships
one: What's New is text only (a screenshot of a working profile shows real
documents, names and hosts, and `scripts/privacy-scan.sh` refuses raster
images outside `build/icons/` and `public/`). The release command only ever
generates `text` and `list` blocks.
`changelog.json` carries the same entries as text only (`version`, `date`,
features with `category`, an optional `title` and `description[]`); the
release command keeps both in step for generated entries - when you hand-edit the generated `.js`, mirror the edit there if you
want CHANGELOG.md to match.

## Testing the window

Clear the seen marker and reload: `localStorage.removeItem('whatsNewLastSeen')`.
Automated coverage: `tests/whats-new-window.test.mjs` (jsdom),
`tests/whats-new-live.test.mjs` (headless Chrome), `tests/whats-new-from-git.test.mjs`
and `tests/release-command.test.mjs` (throwaway git repositories),
`tests/app-version-consistency.test.mjs`.
