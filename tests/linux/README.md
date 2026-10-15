# Linux reproduction environment

Tooling to reproduce and check **Linux-only** behaviour of the app (layout
differences such as classic scrollbars, Linux fonts, path handling, ...) from
any host, using a Linux container with Node 24 and Debian Chromium.

It reuses the repo's root `Containerfile` and the `jacarium-builder`
image that `rebuild.sh` builds, so if you already build Linux packages there is
nothing new to build. The container runtime is detected like `rebuild.sh`:
podman first, docker as fallback.

## Prerequisites

- podman (`podman machine start` on macOS) or docker
- network access **once**: to build the image (if you never ran `rebuild.sh`)
  and to install the container's own `node_modules` (`run.sh deps`). After
  that every command works offline: Chromium, fonts and all dependencies live
  in the image and in two named volumes
  (`jacarium-linux-node_modules`, `jacarium-linux-central-node_modules`).

The host's `node_modules` are never used inside the container (they contain
macOS binaries); the volumes are refreshed automatically whenever
`package-lock.json` changes.

## Usage

```bash
tests/linux/run.sh deps                                  # one-time / after lockfile changes
tests/linux/run.sh shell                                 # bash inside the container, repo at /build
tests/linux/run.sh exec npx eslint src/components        # any command
tests/linux/run.sh test tests/connection-indicator.test.mjs   # one test file (.mjs or .py)

# Screenshot + layout measurements of a page in Linux Chromium
tests/linux/run.sh screenshot --page Documents --out documents
tests/linux/run.sh screenshot --page Documents --selector 'div[style*="width"]' \
    --measure 'div.flex-1.overflow-y-auto' --out documents-sidebar
tests/linux/run.sh screenshot --page Kanban --overlay-scrollbars --dark --out kanban-overlay

# Worked example: the Documents sidebar right-hand gap
tests/linux/run.sh example documents-sidebar                     # classic scrollbars (Linux default)
tests/linux/run.sh example documents-sidebar --overlay-scrollbars # what the Electron fix enables
```

`--rebuild-image` forces an image rebuild; `--no-deps` skips the dependency
check for a faster start.

Outputs (PNG + JSON with the measurements) go to `tests/linux/out/`, which is
git-ignored. `tests/run-all.sh` only picks up `tests/*.test.mjs` /
`tests/*.test.py`, so nothing under `tests/linux/` runs as part of the normal
suite - these need a container and are run by hand.

## Reusing it for a new issue

1. Reproduce interactively first:
   `tests/linux/run.sh screenshot --page <Page> --measure '<css selector>'`
   prints, for the element and each ancestor, `scrollWidth`/`clientWidth`/
   `offsetWidth`, the scrollbar gutter and whether it overflows horizontally.
   Compare with `--overlay-scrollbars` (macOS-like zero-width scrollbars) to
   tell "classic scrollbar gutter" apart from real content overflow.
2. If the page needs state (seeded records, an expanded tree, an open dialog),
   write a small setup module and pass it with `--setup`:
   ```js
   // tests/linux/setups/my-issue.mjs  (synthetic data only - never real records)
   export default async function ({ evaluate, send, sleep }) {
     await evaluate(`(async () => {
       const m = await import('/src/utils/documents.js');
       await m.createDocument({ title: 'Synthetic title', content: 'x', category: 'General' });
     })()`);
     await send('Page.reload'); await sleep(4000);
   }
   ```
   Anything served by Vite can be imported inside `evaluate` (the app's own
   IndexedDB helpers are the easiest way to seed data).
3. Turn it into a repeatable check: copy `examples/documents-sidebar.mjs`,
   keep the header comment describing the bug and what the checks prove, and
   run it with `tests/linux/run.sh example <name>` before and after the fix.
   The helpers in `lib/harness.mjs` (`startVite`, `launchChromium`, `connect`,
   `measureChainExpr`, `clickNavPage`, `makeChecker`) are the whole API.

Scripts also run outside the container (`CHROME_BIN=... node tests/linux/...`),
which is useful for a side-by-side macOS vs Linux comparison of the same
measurements.

Notes:
- The harness starts Vite with `lib/vite.config.mjs` (the repo config with file
  watching disabled): watching the whole mounted repo exceeds the VM's inotify
  limit, and the headless browser never needs HMR. The first Vite start in a
  fresh VM pre-bundles all dependencies, which can take a couple of minutes;
  the harness waits for that before opening the browser.
- Debian Chromium in the image uses classic scrollbars, like the Electron
  build on Linux, so scrollbar-gutter layout differences reproduce faithfully.
