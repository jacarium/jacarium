# How to release

Releases are local and offline (this repository has no remote): nothing is
pushed, tagged remotely or published.

```bash
npm run release              # next version (2.6.0 -> 2.6.1 ... 2.6.9 -> 2.7.0 ... 2.9.9 -> 3.0.0); or: npm run release -- 2.7.0
# review src/whats-new/versions/vX.Y.Z.js
npm run release:tag          # commit "Release vX.Y.Z" + local annotated tag vX.Y.Z
```

Each release adds its notes to the What's New window and to the top of
`CHANGELOG.md`; the root `README.md` is the project's pitch and is not
touched by a release.

Details, the entry format and the tests: `src/whats-new/README.md`.

## Release to GitHub in one command

`scripts/publish-release.sh` runs the whole sequence: it tags the release
here (`npm run release`), exports that tag into the clone of the public
repository (`scripts/export-source.sh`), commits and pushes it there and
pushes the tag - which starts the GitHub release workflow. `--deploy`
also deploys it to your home server. It asks before each step (`--yes`
skips the questions) and `--dry-run` shows the plan and the release notes
without changing anything:

```bash
scripts/publish-release.sh --dry-run    # the plan and the notes
scripts/publish-release.sh              # next version, asking before each step
scripts/publish-release.sh --deploy     # ... and deploy to the home server too
```

Its personal settings (the public clone's path, the home server's ssh
target) live outside the repository, in `~/.config/jacarium/release.env` -
see `scripts/publish-release.sh --help`. On GitHub you then approve the
`quay` environment when the image job waits, and publish the draft release.

Without `--yes` it pauses after writing the release notes so you can edit
`src/whats-new/versions/vX.Y.Z.js` before it tags. If a run stops after the
tag (a failed push, a deploy error), fix the cause and run it again with
`--resume`: it publishes the version already tagged here and only does what
is left. Without `--resume` it never republishes an existing version - it
stops and tells you which of the two you meant. Commit nothing directly on GitHub - the next export overwrites it, and
the script refuses to run while GitHub has commits the clone doesn't.

## Fedora / RHEL: the COPR repository

`sudo dnf copr enable robincernin/jacarium && sudo dnf install jacarium`
installs the desktop app on Fedora 42-45 and EPEL 10 (x86_64 and aarch64)
from https://copr.fedorainfracloud.org/coprs/robincernin/jacarium/. The
package is the official release RPM repackaged (`packaging/copr/`): COPR
builds `packaging/copr/jacarium.spec` from the public repository at the
release's tag; the spec downloads that release's `jacarium-<version>.<arch>.rpm`
and `SHA256SUMS.txt` from GitHub, verifies the checksum, unpacks the RPM and
installs the same files, dependencies and scriptlets (the SUID
`chrome-sandbox` decision included), plus an AppStream metainfo. On EL 10
the dependencies need EPEL enabled on the user's machine (libXScrnSaver is
an EPEL package), as for the downloaded RPM.

**When it builds.** The release workflow creates a DRAFT release; its assets
are public only once you publish it, so a COPR build must start AFTER that.
COPR's own GitHub webhook reacts to pushes and tag creation (it would build
on the tag push, before the assets exist, and fail), and its "custom"
webhook starts a build of the default branch on ANY POST - GitHub sends
one for every release action, the draft's creation and each edit included -
so neither fits. The trigger is a workflow of its own in the public clone,
`.github/workflows/copr.yml`, that runs only on `release: published` and asks
COPR to build exactly that tag with `copr-cli` (python + pip, no third-party
action): `packaging/copr/github-workflow-copr.yml` is a copy of it. It is not
part of `release.yml`, so publishing a release re-runs none of the build or
image jobs.
If it ever fails (an expired token, say), the same build by hand, with
`copr-cli` and your token file at `~/.config/copr`:

```bash
copr-cli buildscm --clone-url https://github.com/jacarium/jacarium.git --commit vX.Y.Z --spec packaging/copr/jacarium.spec --method make_srpm robincernin/jacarium
```

**One-time setup (needs your COPR and GitHub logins):**

1. COPR > New project `jacarium` (or robincernin/jacarium > Settings):
   chroots fedora-42..45 x86_64 + aarch64 and epel-10 x86_64 + aarch64;
   "Enable internet access during builds" ON (the spec downloads the
   release assets); "Generate AppStream metadata" ON; description and
   instructions as you like (`sudo dnf copr enable robincernin/jacarium`).
   No package definition is needed: the first build creates the package
   `jacarium`. (If you add one under Packages > SCM anyway - Clone url
   `https://github.com/jacarium/jacarium.git`, Spec `packaging/copr/jacarium.spec`,
   method `make_srpm` - leave its "Auto-rebuild" webhook OFF.)
2. COPR > https://copr.fedorainfracloud.org/api/ : copy the whole token
   file shown there (`[copr-cli]` ... `token = ...`). It is valid for 180
   days; COPR mails you before it expires - then repeat this step and the
   next.
3. GitHub > jacarium/jacarium > Settings > Secrets and variables > Actions >
   New repository secret: name `COPR_API_TOKEN`, value = that token file.
4. In the public clone, copy `packaging/copr/github-workflow-copr.yml` to
   `.github/workflows/copr.yml`, commit and push it there (like
   `release.yml` it lives only in the public clone; the export does not
   touch `.github/`).
5. Publish a release as usual (`scripts/publish-release.sh`, then publish
   the draft on GitHub). The `copr` job starts within a minute, COPR builds
   both architectures for every chroot (a few minutes each), and
   `dnf upgrade` on a machine with the repository enabled gets it.

**Testing a spec change locally** (no COPR, no login - podman or mock):

```bash
# the published assets of the version the spec names, once
mkdir -p /tmp/jacarium-copr && cd /tmp/jacarium-copr
curl -LO https://github.com/jacarium/jacarium/releases/download/v3.2.9/SHA256SUMS.txt
curl -LO https://github.com/jacarium/jacarium/releases/download/v3.2.9/jacarium-3.2.9.aarch64.rpm   # or .x86_64.rpm
# a throwaway Fedora (quay.io/centos/centos:stream10 for EPEL 10; --arch amd64 for x86_64 on an ARM Mac),
# the assets as rpmbuild SOURCES so %prep does not download them again
podman run --rm -it -v $PWD:/a:ro -v ~/Documents/jacarium:/src:ro registry.fedoraproject.org/fedora:43 bash -c '
  dnf -y install rpm-build cpio curl desktop-file-utils libappstream-glib util-linux-core &&
  mkdir -p ~/rpmbuild/SOURCES ~/rpmbuild/SPECS && cp /src/com.jacarium.app.metainfo.xml /src/LICENSE /a/* ~/rpmbuild/SOURCES/ && cp /src/packaging/copr/jacarium.spec ~/rpmbuild/SPECS/ &&
  rpmbuild -bb ~/rpmbuild/SPECS/jacarium.spec && dnf -y install ~/rpmbuild/RPMS/*/jacarium-*.rpm &&
  desktop-file-validate /usr/share/applications/com.jacarium.app.desktop && appstream-util validate-relax --nonet /usr/share/metainfo/com.jacarium.app.metainfo.xml && rpm -V jacarium'
```

With `mock` installed (`sudo dnf install mock`, your user in the `mock`
group): `packaging/copr/make-srpm.sh --outdir /tmp/srpm`, then
`mock --enable-network -r fedora-43-x86_64 /tmp/srpm/jacarium-*.src.rpm`
(also `fedora-43-aarch64`, `centos-stream+epel-10-x86_64`); the network is
for the spec's download.

