# Development and building

Running Jacarium from source, building the desktop app, and the Python
dependencies of the backend.

## Development and building

One script per task, each with `--help`:

```bash
./run.sh                          # development: Vite dev server + Electron (hot reload)
./run.sh --profile alice --port 8080 --machine-id alice@test   # a second identity next to the first
./run.sh --packaged               # the app built by ./rebuild.sh (dist-electron/)
./start-backend.sh                # the Flask backend alone (for `npm run dev` without Electron)
./rebuild.sh                      # Linux AppImage, built in a container (podman or docker)
./rebuild.sh --format deb         # another format; --no-container builds on this host
./rebuild.sh --no-container --platform mac   # on a Mac: a dmg (--format "dmg zip" or zip for more)
./rebuild.sh --testing            # a testing build: DevTools open, MACHINE_ID honoured - never ship it
./tests/run-all.sh                # every test
```

`npm run build` (scripts/build-ui.sh) builds the UI alone; `npm run
electron:build:full` builds backend, UI and the package for this machine.
The shell scripts share `scripts/lib.sh` and pass `shellcheck`
(`tests/scripts.test.mjs` checks them, and runs shellcheck when it is
installed: `brew install shellcheck`, or `npm install --no-save shellcheck`).

Local AI models: install [Ollama](https://ollama.com) and leave it on its
default port; Settings > AI Providers offers it.

## Linux desktop integration

Which icon a Linux desktop shows for a Jacarium window depends on two
things that must agree, and `tests/linux-desktop-integration.test.mjs`
guards both:

- **The window icon.** Every `BrowserWindow` in `electron/main.cjs` (the
  main window, the profile picker, the pop-out windows) and the About panel
  use `WINDOW_ICON`, `build/icons/512x512.png`, which is packaged as it is
  (`build.files`), so the path resolves in development and inside
  `app.asar`. On X11 this is what the title bar, the task switcher and the
  docks show for a window no `.desktop` file claims, e.g. an AppImage that
  was run directly. On Wayland a window carries no icon of its own: the
  desktop shows the icon of the `.desktop` entry it matches the window to.
- **Window association.** Electron's `app_id` (Wayland) and `WM_CLASS`
  (X11) are the package.json `desktopName` without `.desktop`:
  `com.jacarium.app`. With `build.linux.syncDesktopName` electron-builder
  names the installed entry `com.jacarium.app.desktop` and writes
  `StartupWMClass=com.jacarium.app` into it (and `Icon=jacarium`, the
  hicolor icon the deb and rpm install under
  `/usr/share/icons/hicolor/<size>/apps/jacarium.png`), so GNOME and KDE
  find the entry for every window. This also covers an AppImage integrated
  by appimaged, AppImageLauncher or Gear Lever, whose desktop file is
  renamed and leaves only `StartupWMClass` to match on. Without
  `desktopName`, Electron fell back to the slug `jacarium` while
  electron-builder wrote `StartupWMClass=Jacarium`, and an integrated
  AppImage got the generic icon.

An AppImage that is simply run, without integration, shows its icon on X11
(from the window) but not on GNOME Wayland (no `.desktop` entry to match):
integrate it, or install the deb / rpm.

To check on a Linux desktop: start the app and run `xprop WM_CLASS` (click
the window; X11 or XWayland) - both values should be `com.jacarium.app` -
or, on GNOME Wayland, open Looking Glass (Alt+F2, `lg`, Windows tab) and
read the window's `app_id`. The installed entry is
`/usr/share/applications/com.jacarium.app.desktop`; the AppImage's own is
in its root (`./Jacarium-*.AppImage --appimage-extract`, then
`squashfs-root/com.jacarium.app.desktop`, with `.DirIcon` and
`jacarium.png` next to it).

## Urgent dependency updates (the security lane; only on the user's explicit request)

The rule is 7 days: `.npmrc` refuses package versions published less than
seven days ago (`min-release-age=7`), the Python lock and the pip installs
have the same cooldown, base images are pinned by digest and a week old, so
a hijacked release has time to be caught. The security lane (SECURITY.md,
"Dependency policy", decided 2026-10-31) is the one exception, per package:
a version that fixes a published advisory - a CVE, GHSA, PYSEC, RHSA or GO
id reported by Grype, OSV-Scanner, `npm audit` or GitHub - may be installed
once it is at least **2 days** old, provided the publisher matches the
previous version's (or the move to trusted publishing is documented), the
registry signature and the provenance where it exists check out, the code
diff is reviewed (no new dependency, install script, or network / file /
eval / exec use beyond the fix) and the entry is written in
`docs/security/urgent-updates.md`. Younger than 2 days only on the
maintainer's explicit decision (`--force`), said so in the entry. `.npmrc`
and the pip cooldown are never edited. Never run any of this on your own
initiative, and never for "everything". One script per ecosystem does the
checks, so the evidence in the log is reproducible by anyone:

- **npm**: `npm run deps:urgent -- <name@x.y.z> [...] --reason "<GHSA / CVE ...>" [--dry-run] [--diff]`
  (`scripts/urgent-dep-update.cjs`) installs exactly those versions past the
  limit: it refuses without explicit specs and a `--reason` naming an
  advisory id, checks each version first (the publisher against the
  installed version's, the registry signature, the SLSA provenance and its
  repository, the tarball diffed against the installed copy with new
  dependencies, install scripts and new child_process / fs / network / eval /
  env usage flagged, the version's age - younger than 2 days is a red flag),
  stops on a red flag unless `--force` is given, installs with a one-off
  `--min-release-age=0` (an override for a transitive package, the dependency
  field for a direct one), then checks the lockfile diff and integrity, runs
  `npm audit` and `npm audit signatures`, reinstalls the test-only packages,
  appends the first draft of the entry to `docs/security/urgent-updates.md`
  and prints the commit message. `--dry-run` runs every check and installs
  nothing; `--diff` prints the unified diff of the changed source files for
  the review.
- **PyPI**: `scripts/verify-pypi-release.py NAME OLD NEW [--diff] [--compare-tag OWNER/REPO@TAG]`
  reports the age, the PEP 740 provenance of every file (the Trusted
  Publisher's repository, workflow and environment) against OLD's, the
  release metadata's author / maintainer, the project page's maintainer
  accounts, the sdist's and one wheel's sha256 against the index, the two
  trees diffed (new subprocess / network / eval / ctypes / env use, a changed
  build backend or an added setup.py are red flags), the dependency changes
  and, with `--compare-tag`, the import packages against the project's git
  tag - the check that stands in for provenance where a project has none.
  `backend/lock-requirements.sh --past-cooldown NAME==VERSION` runs it
  against the version the lock holds before resolving, stops on a red flag
  unless `--force` is given, and keeps the versions already approved in
  `backend/cooldown-exceptions.txt` exempt from the cutoff; the new version
  then goes into that file with its advisory, upload date and the date it was
  added (`tests/cooldown_exceptions.test.py` checks the two days).
- **Red Hat RPMs** (the `microdnf ... upgrade` line in deploy/Containerfile):
  `scripts/verify-rpm-update.sh --cve CVE-... NAME-VERSION-RELEASE [...]`
  finds the erratum in Red Hat's security data, reads its first release date
  (the age), severity and fixed packages from the CSAF document, upgrades the
  package inside a throwaway container from the pinned base image (gpgcheck
  on) and reports the installed version-release, the signature's key id
  (Red Hat's release key 2 unless `--key` adds another), vendor, build time
  and source RPM. `--advisory RHSA-...` when the erratum is known,
  `--no-container` for the advisory checks alone.
- **Go modules** (the Caddy build's `*_VERSION` arguments):
  `scripts/verify-go-module.sh MODULE VERSION [--expect-sum h1:...] [--go-sum FILE]`
  reads the checksum database record (the module and go.mod hashes, compared
  with what is expected) and the proxy's record (the version's time and age,
  the VCS origin, tag and commit).

Each prints `no red flag` and exits 0, or the flags and exits 1; the tests
`tests/urgent-dep-update.test.mjs`, `tests/verify_pypi_release.test.py`,
`tests/verify_rpm_update.test.py` and `tests/verify_go_module.test.py` drive
them against local fakes (no network).

## Python dependencies

`backend/requirements.txt` lists the backend's direct dependencies;
`backend/requirements.lock` is the full resolved set (every package, one
exact version, for Python 3.14 on Linux, macOS and Windows). The desktop
venv and the container run the same Python minor version, 3.14: the
container image installs Red Hat's `python3.14` on `ubi9-minimal`, and locally `rebuild.sh` picks
Homebrew's `python@3.14` (`brew install python@3.14`; on Linux, the
distribution's `python3.14` package). Everything that installs the backend -
`start-backend.sh`, `backend/build_backend.sh`, `rebuild.sh` and
`deploy/Containerfile` - runs

```bash
pip install -r requirements.txt -c requirements.lock
```

so the desktop venv, the PyInstaller build and the container end up with the
same versions, and pip refuses to install when the lock no longer satisfies
`requirements.txt`. Edit the lock only through the script:

```bash
backend/lock-requirements.sh                      # after changing requirements.txt
backend/lock-requirements.sh --upgrade-package X  # let one package (and its needs) move
backend/lock-requirements.sh --upgrade            # newest allowed version of everything
backend/venv/bin/pip install -r backend/requirements.txt -c backend/requirements.lock
```

The script uses `uv` (from PATH, or installed into a temporary venv for the
run) and only considers releases published at least 7 days ago, the same
cooldown as `.npmrc` and the pip installs in the build scripts.
`tests/requirements_lock_consistency.test.py` (part of `tests/run-all.sh`)
checks that the lock matches `requirements.txt` and that the venv matches
the lock. To look for known vulnerabilities, audit the lock itself so local
and container are judged on the same versions:

```bash
pip-audit --no-deps -r backend/requirements.lock
```
