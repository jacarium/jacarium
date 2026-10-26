# Fedora COPR packaging

`sudo dnf copr enable robincernin/jacarium && sudo dnf install jacarium`
(https://copr.fedorainfracloud.org/coprs/robincernin/jacarium/ - Fedora 42
to 45 and EPEL 10, x86_64 and aarch64).

- `jacarium.spec` repackages the official GitHub release RPM for the build's
  architecture: `%prep` downloads `jacarium-<version>.<arch>.rpm` and
  `SHA256SUMS.txt` from the release, verifies the checksum, unpacks the RPM
  and installs the same tree (`/opt/Jacarium`, the desktop entry, the icons)
  with the same dependencies and scriptlets, plus the repository's AppStream
  metainfo (`com.jacarium.app.metainfo.xml`, which the official RPM lacks).
- `make-srpm.sh` makes the SRPM for COPR's `make_srpm` source method
  (`.copr/Makefile` at the repository root calls it): the version is the git
  tag of the checkout (v3.2.9 -> 3.2.9); the SRPM holds the spec, the
  metainfo and the repository's LICENSE. The spec's own
  `%global jacarium_version` is only the fallback for a build by hand;
  `npm run release` bumps it with package.json and adds the `%changelog`
  entry.
- `.github/workflows/copr.yml` (at the repository root, exported with the
  rest of `.github/`) asks COPR to build when a GitHub release is published
  (a workflow of its own, so publishing re-runs nothing else).

How to release it, test it locally and set COPR up: `docs/HOW_TO_RELEASE.md`.
