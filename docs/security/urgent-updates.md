# Urgent dependency updates

Every run of `npm run deps:urgent` (scripts/urgent-dep-update.cjs): a dependency installed past `.npmrc`'s `min-release-age` on the user's explicit request, with the checks that were run first.

The same log holds the Python counterpart: `backend/lock-requirements.sh --past-cooldown NAME==VERSION`, a release
younger than the 7-day cooldown locked on the user's explicit request, after the checks below were done by hand
(there is no script for PyPI yet): the publisher is the same as the previous release's (PyPI's PEP 740 provenance -
the Trusted Publisher's repository, workflow and environment - where the project publishes one; the project page's
maintainers and the sdist compared with the project's git tag where it does not), no new dependency, no new build
hook, no new subprocess / socket / network / eval / ctypes use in the changed files, and the age.

## 2026-10-26 - certifi==2026.10.19, brotli==1.2.1, pillow==13.0.0, fastembed==0.9.1

Reason: Quay's scan of the published image (critical): pillow GHSA-8g5g-8vmr-9782, GHSA-w889-685w-c8fh,
GHSA-332p-7hrc-92wf, GHSA-5x8w-8jj5-q52h, GHSA-v9pv-5gc8-w2m6; brotli PYSEC-2026-4322 / GHSA-9v8h-qqgm-4m35; certifi
GHSA-6q48-6c7w-9gw2 / PYSEC-2026-4320. fastembed 0.9.1 is not a fix: it is the first fastembed that allows pillow 13
(0.8.0 to 0.9.0 pin `pillow<13`), so pillow 13 cannot be installed without it.

- certifi 2026.7.22 -> 2026.10.19: uploaded 2026-10-20 02:24 UTC, 6.3 days old. PEP 740 provenance on the sdist and
  the wheel, the same Trusted Publisher as 2026.7.22 (GitHub certifi/python-certifi, release.yml, environment
  release). No dependencies before or after. sdist: 19 -> 19 files, 5 changed (the version in `__init__.py`,
  `setup.py`, `cacert.pem`, the two PKG-INFO), nothing added or removed, no new risky call.
- brotli 1.2.0 -> 1.2.1: uploaded 2026-10-22 13:57 UTC, 3.8 days old. No PEP 740 provenance (1.2.0 had none either);
  the project page lists the maintainers google_opensource, eustas, anthrotype (unchanged); the sdist's `c/` and
  `python/` trees are identical to the GitHub tag v1.2.1 (118 files, only the generated egg-info differs). No
  dependencies. sdist: 200 -> 200 files, 5 changed (`c/common/version.h`, `c/dec/decode.c`, `c/include/brotli/decode.h`,
  the two PKG-INFO - the decoder fix); the manylinux cp314 wheel differs only in the compiled `_brotli` module. No
  new risky call.
- pillow 12.3.0 -> 13.0.0: uploaded 2026-10-16 22:15 UTC, 9.5 days old (older than the cooldown; the bypass is for
  fastembed). PEP 740 provenance on the sdist and the cp314 wheels for macOS arm64, manylinux x86_64 and aarch64,
  the same Trusted Publisher as 12.3.0 (GitHub python-pillow/Pillow, wheels.yml, environment release-pypi). No
  runtime dependencies before or after; requires-python 3.10 -> 3.11. sdist: 1723 -> 1728 files, 339 changed (a
  major release: 75 C/H files, the PIL plugins, tests and docs), 12 added (test images for the advisories, the 13.0.0
  release notes, a raqm data header), 7 removed (test images, an install script, a libtiff patch); `setup.py`,
  `pyproject.toml` and `MANIFEST.in` changed for the version and the Python floor; no new risky call. Pillow 13's
  breaking changes (I-mode PNG clipping, `get_child_images` moved, `ImageColor.getcolor` premultiplied, removed
  `Image._show` / `ImageCms` product fields / `ExifTags.IFD.Makernote`) touch nothing here: no Jacarium module imports
  PIL; pillow is installed only because fastembed requires it (its image models, which Jacarium never loads).
- fastembed 0.8.0 -> 0.9.1: uploaded 2026-10-24 18:23 UTC, 1.6 days old. No PEP 740 provenance (0.8.0 had none
  either); PyPI's project page was behind its bot challenge, so the maintainers could not be read; the sdist's
  `fastembed/` tree is identical to the GitHub tag v0.9.1 (69 files), whose release (2026-10-24 18:32 UTC) names
  the same changes. The dependency set is unchanged (huggingface-hub, loguru, mmh3, numpy, onnxruntime, pillow,
  py-rust-stemmers, requests, tokenizers, tqdm - markers reworded, pillow `<13` -> `<14`); the project moved its
  build to uv (`[tool.uv.build-backend]`, pure-Python wheel, no build hook); the author list now also names the
  original author (NirantK). sdist: 64 -> 75 files, 11 added (new model classes: potion static embeddings,
  SigLIP, LateOn, inference-free SPLADE, safetensors / external-data helpers), 42 changed; the new and changed
  modules import nothing beyond the dependency set and the standard library; no new risky call. 0.9.0 / 0.9.1
  changes that matter here: built-in models download from Hugging Face only, and the default model
  `BAAI/bge-small-en-v1.5` now resolves to `Qdrant/bge-small-en-v1.5-onnx-Q` (since 0.8.1) - the model is
  re-downloaded into the new cache directory on first use; mean-pooling models return float32 (not float64).
  Functional check: the RAG tests (tests/rag_*.test.py) and the lock consistency test after the install.

filelock 3.32.5 -> 4.2.2 moved in the same lock run, within the cooldown (uploaded 2026-10-18, 8.1 days; Quay named
4.2.1 as the fix; 4.2.2 is the newest under the cutoff): the same Trusted Publisher (GitHub tox-dev/filelock,
release.yaml, environment release), no dependencies, new `ctypes` / `socket` use in `_util.py` (the hard-link
owner lookup of the new read-write lock; huggingface_hub uses `FileLock` only).

Lock: `backend/lock-requirements.sh --past-cooldown certifi==2026.10.19 --past-cooldown brotli==1.2.1
--past-cooldown pillow==13.0.0 --past-cooldown fastembed==0.9.1 --upgrade-package filelock` (fastembed bumped in
requirements.txt, where it is direct); the lock changed in exactly those five lines. Checks after the install: see
the commit.

## 2026-10-26 - base image ubi9/python-314 1-1792864219 (ca-certificates 2026.2.92)

Reason: CVE-2026-114406 (critical) in ca-certificates 2025.2.80_v9.0.305-91.el9, fixed in RHEL 9.8 by
2026.2.92_v9.0.319-90.3.el9_8 (the one CRITICAL the local trivy scan of the image left after the Python fixes
above). Only the ubi9/python-314 build 1-1792864219 (2026-10-24) carries it - the 2026-10-22 build 1-1792671590
still has the old bundle - so the image moved to a build two days old; the user approved this one-off exception
to the seven-day rule for the critical fix.

- Registry: pulled from registry.access.redhat.com, pinned by its manifest-list digest
  sha256:840cb26cf8d90055a9d7811953773d7a4204ce9fb82ef34a0775a1bb26a3a892.
- Red Hat's signatures (simple signing, published at access.redhat.com/webassets/docker/content/sigstore) of the
  amd64 manifest sha256:00042efeae337876121f99333e29731b7191d76bd9a233c719abeea02ef23d98 and the arm64 manifest
  sha256:3c2bef569683edca80c50e5cc9b7ce82360a770b7554bfce72521eb3bdee651b verified with gpg against Red Hat's
  release key 2, fingerprint 567E347AD0044ADE55BA8A5F199E2F91FD431D51 (the published fingerprint; the key file
  taken from /etc/pki/rpm-gpg of the base image already in use, because the key downloads from
  access.redhat.com/security/data answered with a web page): GOODSIG / VALIDSIG, the signed payloads naming
  exactly those digests and registry.access.redhat.com/ubi9/python-314, creator konflux-signing.
- RPM difference to the previous base 1-1792067380 (2026-10-15): 469 -> 470 packages, 18 changed, 1 added, 0
  removed - ca-certificates 2025.2.80_v9.0.305-91.el9 -> 2026.2.92_v9.0.319-90.3.el9_8; expat and expat-devel
  2.5.0-6.el9_8.5 -> .7; httpd, httpd-core, httpd-devel, httpd-filesystem, httpd-tools, mod_ldap, mod_lua,
  mod_session, mod_ssl 2.4.62-13.el9_8.6 -> .9; emacs-filesystem 27.2-18.el9_8.2 -> .3; kernel-headers
  5.14.0-687.58.1 -> 687.60.1.el9_8; openssh and openssh-clients 9.9p1-12 -> 13.el9_8; environment-modules
  5.3.0-2.el9 -> el9_8.1; perl-URI 5.09-3.el9 -> el9_8.1; added perl-Unicode-Normalize. Every change is a RHEL
  9.8 erratum; python3.14 stays 3.14.8-1.el9_8 and openssl-libs 3.5.8-2.el9_8.
- Side effect: of the 67 OS findings the previous scan marked "fix available" (expat CVE-2026-77214, the four
  httpd CVEs, emacs-filesystem CVE-2026-96442, the ca-certificates one and the rest), every one is gone - trivy
  on the new image: 0 OS findings with a fix available, 235 HIGH without one (RHEL has no fix yet: kernel-headers,
  libX11, util-linux, libbrotli, ...), no CRITICAL; the image went from 311 to 244 HIGH+CRITICAL findings. The
  remaining non-OS findings are unchanged (Caddy's Go toolchain, pip's vendored copies).

Checks after the build: tests/container-deploy.test.mjs builds and drives the image (121 checks), rpm -q inside
shows ca-certificates 2026.2.92_v9.0.319-90.3.el9_8, a TLS smoke test with the image's Python reaches pypi.org
and quay.io through the system bundle (/etc/pki/tls/cert.pem, ssl's default context) and through requests /
certifi, and refuses a self-signed certificate; deploy-podman-machine passes.

## 2026-10-27 - body-parser@2.4.0 (the root and jacarium-central)

Reason: GHSA-27r3-jxmh-p828 (denial of service through trailing bytes after a compressed request body; high),
the same advisory the 1.x line needed 1.20.9 for. Express 5 brought body-parser 2.3.0 into both trees; the fix
for the 2.x line, 2.4.0, was published 2026-10-22 and was 5 days old. The user approved this one-off exception
for exactly `body-parser@2.4.0`; nothing else went past the cooldown.

Run: `npm run deps:urgent -- body-parser@2.4.0 --reason GHSA-27r3-jxmh-p828` in the root, and the script's
`main()` with `repoDir` pointed at jacarium-central (it has no option for a second tree). Both runs stopped on
the same four red flags, read and then passed with `--force`:

- The publisher changed: 2.3.0 was pushed by the maintainer's own account (`ulisesgascon`); 2.4.0 was published
  by GitHub Actions through npm Trusted Publishing (OIDC), with the same maintainer recorded as the approver.
  2.4.0 therefore carries what 2.3.0 did not have: a SLSA v1 provenance attestation naming the source
  `https://github.com/expressjs/body-parser` at `refs/tags/v2.4.0`, the workflow
  `.github/workflows/npm-publish.yml`, the builder `https://github.com/actions/runner/github-hosted`, the
  commit b4744d739e1e2e5257f2ddac31eed191aa5152a4 and the tarball's sha512 - decoded by hand from the
  registry's attestation bundle and matching the script's reading. The registry signature (key
  SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U) is the same key as 2.3.0's; `npm audit signatures` is
  clean in both trees. A move from a personal publish to the project's own publishing workflow with provenance
  is a stronger position than before, not a weaker one.
- Three dependency ranges moved: content-type ^2.0.0 -> ^2.1.0, iconv-lite ^0.7.2 -> ^0.7.3, qs ^6.15.2 ->
  ^6.16.1. No new package: both locks already held content-type 2.1.0 (74 days old), iconv-lite 0.7.3 (115
  days) and qs 6.16.1 (12 days), and the lock diff of each tree is the one body-parser entry. The
  devDependencies changed too (eslint 9, neostandard), which the tarball does not carry.

The tarball diff, read by hand (6 files changed, none added or removed; no install script - `scripts` holds
lint and test only; no new child_process / fs / net / eval / env use): the fix is in lib/read.js. The
decompression stream (gzip / deflate / br, and zstd where Node has it) used to stay piped to the request after
the body had been read, so bytes arriving after the compressed member reached a stream nobody listened to any
more; 2.4.0 unpipes and destroys that stream once the body is in, attaches a no-op error listener to it and
calls `req.resume()` so the request is drained and can finish. The same file also checks the charset before the
decompression stream is created (an unsupported charset could otherwise leave a decoder piped with no error
listener), adds zstd, and takes `getCharset` over from lib/utils.js; lib/types/json.js tightens the strict
first-character check (an all-whitespace body no longer matches); lib/types/urlencoded.js is a shorthand
rewrite; README.md documents the behaviour. Nothing touches what the two servers rely on (express.json with a
50 MB limit; the servers keep that line unchanged, tests/audit-mitigations.test.mjs sees to it).

Local check: an Express app on each unpacked tarball, driven with a compressed JSON body followed by trailing
bytes (gzip, deflate and brotli; the bytes in the same packet and in a later one; a second request on the same
kept-alive connection afterwards). On this machine's Node (24) neither version stalls, crashes or leaves the
connection unusable, so the issue could not be reproduced here; the fix is the stream handling above, which the
diff shows is in place.

After the install: .npmrc still min-release-age=7 in both trees; lockfile: 1 entry changed in each, body-parser's
own, integrity = registry; npm audit: 0 vulnerabilities in both; npm audit signatures: ok; the test-only packages
reinstalled with --no-save, lockfiles untouched. The pin is an `overrides` entry `body-parser: ^2.4.0` in each
package.json; it can be removed at the next lock refresh after 2026-10-29, when 2.4.0 resolves on its own.
tests/npm-audit-clean.test.mjs is green again; tests/express5-servers.test.mjs accepts the override only when it
pins 2.4.0 or later.

## 2026-10-29 - the ubi9-minimal image (3.5.2): the base image, xz-libs, golang.org/x/net

The container image moved from ubi9/python-314 to ubi9-minimal with Red Hat's python3.14 (deploy/Containerfile),
which settles the findings the scanners kept reporting against packages nothing in the image ran: the system
Python 3.9 (CVE-2026-19445 / 19553 / 12345), python3-urllib3 (CVE-2026-97687 / 97689), libbrotli
(CVE-2026-111497) and dnf are simply not in the image any more (the Containerfile checks that they stay absent),
and the Caddy build takes go-jose v4.1.6 for GHSA-mgcc-cww5-fp2q (published 2026-10-14, fifteen days old: no
exception needed). The user granted a one-off exception to the seven-day rule for the three items below, so the
image can ship on 2026-10-29; `.npmrc` and the pip cooldown are untouched, nothing else went past the rule.

1. **The base image, ubi9-minimal 9.8-1792742033** (manifest list
   sha256:2d4c4551af6831dcd26bbf86108c4385de5183ec8fe6b5868f6f9640fe47f4ed, built 2026-10-23: six days old).
   The newest build with the ca-certificates 2026.2.92 fix for CVE-2026-114406 that was also at least a week
   old did not exist (the 2026-10-13 build carries the old bundle; the 2026-10-26 build was three days old).
   Provenance: pulled from registry.access.redhat.com by that digest; Red Hat's simple-signing signatures
   (access.redhat.com/webassets/docker/content/sigstore) of the amd64 manifest
   sha256:0e40cd75c9a128b6b9db185c8220193dc46e86dbf97815555df255c622683570 and the arm64 manifest
   sha256:085bcde1479c7f6f3d1229575dec6ad4bf45d4c2ce4bd227f4f43a901fa3897c verified with gpg against Red Hat's
   release key 2 (fingerprint 567E347AD0044ADE55BA8A5F199E2F91FD431D51, the key file from the base image's own
   /etc/pki/rpm-gpg): GOODSIG / VALIDSIG, both made on 2026-10-23, the signed payloads naming exactly those
   digests and registry.access.redhat.com/ubi9/ubi-minimal. The image's labels: name ubi9/ubi-minimal, version
   9.8, release 1792742033; 109 RPMs, ca-certificates 2026.2.92_v9.0.319-90.3.el9_8.
2. **xz-libs 5.2.5-8.el9_8.1** (RHSA-2026:89749, published 2026-10-26: three days old; the RPM built 2026-10-02),
   for CVE-2026-34743 (a buffer overflow / denial of service in liblzma's index handling, moderate) in the
   5.2.5-8.el9_0 every UBI 9 base carries. liblzma is in the image's execute path - the sos report parser opens
   an uploaded report's `.xz` files through Python's lzma module, and an uploaded archive is untrusted input
   (vex/decisions.yaml had it as affected since 3.5.0). Applied as `microdnf ... upgrade xz-libs` in the
   Containerfile's microdnf layer, named explicitly (no blanket update; tests/container_reproducible.test.py
   refuses any other `upgrade`), followed by `rpm -q xz-libs-5.2.5-8.el9_8.1` so a build without the fixed
   version fails. Provenance: served by ubi-9-baseos-rpms (Red Hat's own repository, no subscription) and
   checked by microdnf (gpgcheck=1, the key in the image); in the built image `rpm -qi xz-libs` shows
   Signature RSA/SHA256, 2026-10-21, Key ID 199e2f91fd431d51 (release key 2), Vendor Red Hat, Inc., Source RPM
   xz-5.2.5-8.el9_8.1.src.rpm. The VEX marks CVE-2026-34743 fixed from 3.5.2. The line can go when a later
   ubi9-minimal build carries 5.2.5-8.el9_8.1 or newer itself.
3. **golang.org/x/net v0.62.0** in the Caddy build (XNET_VERSION; published 2026-10-27: two days old), for the
   two advisories Grype reported against 0.60.0 after the move (both rated Unknown, so the gate would not have
   stopped): GO-2026-6860 / CVE-2026-78661, a quadratic slowdown when x/net/html's parser coalesces adjacent
   text nodes, and GO-2026-6866 / CVE-2026-97045, the renderer missing an ancestor's namespace transition when
   it emits raw text, so a crafted document could be re-parsed differently from how it was rendered. Whether
   any Caddy module in the image reaches x/net/html was not verified (the Caddyfile enables no templates), so
   the module is upgraded rather than argued away. Provenance: the Go checksum database record 70195880 -
   `golang.org/x/net v0.62.0 h1:18ELalfM5+XNRwzM2nYqXsZQ9ByS1uhj2O/U7+5jqRY=` and `/go.mod
   h1:WgDCOTH8iwtB66T4/GfI94AHo/hhdb7Hah9NDseQfiI=` - which the build checks (GOSUMDB is on, GOFLAGS=-mod=mod
   with `go get` from the module proxy); the proxy's origin for the version is go.googlesource.com/net at
   commit 3de643db506517b3e652a13cc0b56034cea6b8e6, tag refs/tags/v0.62.0 (the golang/net mirror carries the
   same tag). `caddy build-info` in the image shows `dep golang.org/x/net v0.62.0`, which the Containerfile
   asserts. The VEX marks both advisories affected before 3.5.2 and fixed from it.

Checked for anything else with an available fix, under the same grant: the Grype gate on the built image
(`--ignore-states not-fixed,wont-fix`, the 3.5.2 VEX) lists nothing but the two x/net lines above, and a dry-run
`microdnf upgrade` in the built image finds no newer RPM in the UBI repositories for the installed set - so
nothing else went past the rule.

## 2026-10-29 - the container's Node.js 24.21.0 -> 24.22.1 (CVE-2026-111497)

Approved by the maintainer as part of the same day's grant for the brotli flaw ("brotli2shell"). The v3.6.0
release's Grype gate found Node.js 24.21.0 - copied into the runtime image for the central server - affected by
CVE-2026-111497 (Critical, listed in CISA's Known Exploited Vulnerabilities catalog): Node bundles its own
brotli decoder. Node.js 24.22.1 (released 2026-10-20, nine days before, a security release) fixes it by
cherry-picking the upstream brotli fix into the bundled copy (`deps: brotli: cherry-pick 0ed4268a4401abcb44720963`
in the v24.22.1 changelog), so `process.versions.brotli` still reads 1.2.0; no Node.js release reports 1.2.1.
The application's Python `brotli` package is 1.2.1.

What went past the rule: the image `docker.io/library/node:24.22.1-bookworm-slim`, rebuilt on 2026-10-28 (one
day old), pinned by its manifest-list digest
`sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c`; the Node.js release itself is outside
the cooldown. The image's `node` reports v24.22.1, and the Grype gate on the rebuilt arm64 image (the 3.6.0
VEX, `--ignore-states not-fixed,wont-fix --fail-on high`) reports "No vulnerabilities found".
