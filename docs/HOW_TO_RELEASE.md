# How to release

Releases are local and offline (this repository has no remote): nothing is
pushed, tagged remotely or published.

```bash
npm run release              # Semantic Versioning: the next patch (3.4.9 -> 3.4.10); --minor for new features (3.4.7 -> 3.5.0); --major when users must act (4.0.0); or an exact version: npm run release -- 3.5.0
# review src/whats-new/versions/vX.Y.Z.js
npm run release:tag          # commit "Release vX.Y.Z" + local annotated tag vX.Y.Z
```

Each release adds its notes to the What's New window and to the top of
`CHANGELOG.md`; the root `README.md` is the project's pitch and is not
touched by a release.

**A release that fixes a publicly known vulnerability names it in the notes
by its identifier** (CVE, GHSA, PYSEC or GO id - e.g. "Pillow 12.3.0: fixes
CVE-YYYY-NNNNN"), and `vex/decisions.yaml` records it as `fixed` from that
version (OpenSSF Best Practices: release_notes_vulns; see CONTRIBUTING.md).

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

**Signed.** The commit and the tag in the public clone are SSH-signed
(`scripts/release-sign.sh`: `git commit -S`, `git tag -s`, both verified
against `.github/allowed_signers` before the push); the clone must have
`gpg.format ssh` and `user.signingkey` set, or step 1 stops with the
instructions. There is no unsigned path. Anyone verifies a release with
`git -c gpg.ssh.allowedSignersFile=.github/allowed_signers verify-tag vX.Y.Z`.

**The VEX.** `npm run release` also writes `vex/jacarium-X.Y.Z.openvex.json`
from `vex/decisions.yaml` (`scripts/vex.py`); review the decisions before a
release - a scanner finding that does not affect Jacarium gets a
`not_affected` entry with the reason verified in the code, one with a fix
pending an `affected` entry - and run `npm run vex -- --version X.Y.Z --scan
<grype or trivy json>` to see which findings have no decision yet. The
release workflow refuses a tag whose committed VEX does not match the
decisions.

**What the workflow does with the tag.** `.github/workflows/release.yml`
calls the reusable `build.yml`: the installers and the image are built in
jobs that can sign nothing, their SBOMs (Syft) and the VEX are collected, the
build provenance (SLSA Build L3), the SBOM and VEX attestations are signed
in a job that runs no project code, the image is pushed to quay.io after the
`quay` approval, attested and cosign-signed, and the release job verifies
every attestation with `gh attestation verify` before it creates the draft
release (the installers, `SHA256SUMS.txt`, the SBOMs and the VEX; the notes
end with the verify commands). The image build also runs Grype: a High or
Critical finding with a fix that the VEX does not cover fails the release -
decide it in `vex/decisions.yaml` first (or fix it). README.md's "Verify
this release" block and SECURITY.md describe the result; the GitHub settings
the flow expects are in `docs/security/github-settings.md`.

Without `--yes` it pauses after writing the release notes so you can edit
`src/whats-new/versions/vX.Y.Z.js` before it tags. If a run stops after the
tag (a failed push, a deploy error), fix the cause and run it again with
`--resume`: it publishes the version already tagged here and only does what
is left. Without `--resume` it never republishes an existing version - it
stops and tells you which of the two you meant. Commit nothing directly on GitHub - the next export overwrites it, and
the script refuses to run while GitHub has commits the clone doesn't.

## Interim snapshots

The public repository must not hold only releases (OpenSSF Best Practices
`repo_interim`: interim versions for review between releases). Between
releases, publish the current `main` as a development snapshot:

```bash
scripts/publish-snapshot.sh --dry-run   # the plan and the commit message, nothing changed
scripts/publish-snapshot.sh             # export main @ HEAD, one signed commit, ask, push
```

It uses the same export (`scripts/export-source.sh`, privacy scan included)
and the same SSH signing (`scripts/release-sign.sh --snapshot`, verified
against `.github/allowed_signers`) as a release, makes ONE commit
`Development snapshot: main @ <short sha> (after vX.Y.Z)` whose body lists
the commit subjects since the last export (no merges, no bump / release
commits - the What's New generator's filter), and pushes the public `main`
after a confirmation (`--yes` skips the questions). No tag, no version
bump, no deploy, no release notes, no GitHub release; it refuses a dirty
tree, a branch other than `main`, and a snapshot that would change nothing.
A push to the public `main` runs the CodeQL, Scan and Scorecard workflows
only - `release.yml` runs on tags, the image publishing and COPR with it.

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
so neither fits. The trigger is a workflow of its own,
`.github/workflows/copr.yml` (tracked here and exported to the public clone
with the rest of `.github/`), that runs only on `release: published` and asks
COPR to build exactly that tag with `copr-cli` (python + pip, no third-party
action). It is not part of `release.yml`, so publishing a release re-runs
none of the build or image jobs.
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
4. Nothing to copy: `.github/workflows/copr.yml` is tracked in this
   repository and reaches the public clone with the next export
   (`scripts/export-source.sh` mirrors `.github/` whole, like `release.yml`
   and `build.yml`).
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

