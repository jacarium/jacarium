# Urgent dependency updates

Every dependency installed past the 7-day rule (`.npmrc`'s `min-release-age`, the pip cooldown, the pinned base
image), with the checks that were run first. Since 2026-10-31 this is the **security lane** of the dependency
policy (SECURITY.md, "Dependency policy"): a version that fixes a published advisory (a CVE / GHSA / PYSEC / RHSA /
GO id reported by Grype, OSV-Scanner, `npm audit` or GitHub) may be installed once it is at least 2 days old, per
package, provided the publisher matches the previous version's (or the move to trusted publishing is documented),
the registry signature and the provenance where it exists check out, the code diff is reviewed (no new dependency,
install script, or network / file / eval / exec use beyond the fix), and the entry is written here. Younger than 2
days only on the maintainer's explicit decision, which the entry says. Before that date the entries below were
one-off exceptions the maintainer granted each time.

The checks are scripted, one tool per ecosystem, so the evidence in an entry is reproducible:
`npm run deps:urgent -- <name@x.y.z> --reason "<ids>" [--diff]` (scripts/urgent-dep-update.cjs: the publisher,
`dist.signatures`, SLSA provenance, the tarball diff, the age; it installs and writes the first draft of the entry),
`scripts/verify-pypi-release.py NAME OLD NEW [--diff] [--compare-tag OWNER/REPO@TAG]` (which
`backend/lock-requirements.sh --past-cooldown NAME==VERSION` runs first: the age, the metadata and PEP 740
publisher, the digests, the sdist / wheel diff, the dependencies, the project's git tag),
`scripts/verify-rpm-update.sh --cve CVE-... NAME-VERSION-RELEASE` (the erratum and its date from Red Hat's security
data, the RPM upgraded inside the base image and its signature) and `scripts/verify-go-module.sh MODULE VERSION`
(the checksum database record, the proxy's time and origin). Each exits non-zero on a red flag.

After an npm package comes in through the lane, Dependabot's update runs for anything that depends on it fail
until that version is 7 days old: Dependabot reads `.npmrc`, so `min-release-age` refuses the version the lock
file (or an override) pins as soon as the lock is regenerated (`npm error notarget No matching version found for
<name>@<version> with a date before ...`). `npm ci` from the lock is unaffected. This is expected and resolves on
its own; npm has no per-package exemption, and the 7 days stay. Once the version is past 7 days, "Check for
updates" on the Dependabot page re-runs it without waiting for the weekly schedule (first seen 2026-11-03:
electron-builder blocked by minimatch 11.0.3 until 2026-11-04 20:00 UTC).

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

**Follow-up, 2026-10-29:** body-parser 2.4.0 cleared the seven-day cooldown at 11:39 UTC, so the temporary
`"body-parser": "^2.4.0"` overrides are removed from both package.json files. Express 5's own `body-parser
^2.2.1` now resolves to 2.4.0 under `min-release-age=7` - both lock files are unchanged and hold 2.4.0, and
`npm audit` stays clean.

## 2026-10-31 - the security lane: follow-redirects@1.16.2, joi@17.13.9, pyasn1==0.6.5 (curl-minimal left)

The first batch under the lane, the day it was decided. The Grype gate on the 3.7.0 arm64 image with the
current database (built 2026-10-31T06:18Z) listed six findings with a fix: pyasn1 0.6.4 (four High) and
curl-minimal / libcurl-minimal 7.76.1-40.el9_8.8 (CVE-2026-8932, Medium); `npm audit` listed two High in the
root's dev dependencies (follow-redirects, joi, both reached through wait-on). Ages are as of 2026-10-31 12:35
UTC. Nothing else went past the rule: `.npmrc` and the pip cooldown stay at 7.

1. **follow-redirects 1.16.1 -> 1.16.2** (npm, dev-only: wait-on > axios; the existing override moved to
   `^1.16.2`). GHSA-mrwp-f3q8-3g9p / CVE-2026-116689 (High): `sensitiveHeaders` arrays from another realm were
   discarded, so custom credentials could follow a cross-host redirect. Published 2026-10-25 21:32 UTC, 5.6 days
   old. Publisher `rubenverborgh`, the same account as 1.16.1; two registry signatures (npm's key
   SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U, the same as 1.16.1's); no provenance (1.16.1 had none).
   No dependencies before or after, no install script. Diff (`--diff`): 3 files changed, none added or removed -
   index.js replaces the local `isArray` (`value instanceof Array`, false for an array from another realm) with
   `Array.isArray` at the one place `options.sensitiveHeaders` is checked and drops the helper; README.md adds the
   maintainer's funding notice ("maintenance paused until funding found"); package.json the version. No new
   child_process / fs / network / eval / env use. The notice is worth knowing: the package is a transitive
   development dependency here, nothing in the shipped application loads it.
2. **joi 17.13.8 -> 17.13.9** (npm, dev-only: wait-on; a new override `^17.13.9`). GHSA-4528-x5fx-h6hg /
   CVE-2026-118772 (High): a quadratic-time split in `string().email({ multiple: true })`. Published 2026-10-28
   10:04 UTC, 3.1 days old. Publisher `marsup`, the same account as 17.13.8; two registry signatures with the same
   key; no provenance (17.13.8 had none). Dependencies unchanged (@hapi/hoek, @hapi/topo, @sideway/address,
   @sideway/formula, @sideway/pinpoint), no install script. Diff: 5 files changed, none added or removed -
   lib/types/string.js builds the separator regex only when `multiple` is set and no longer lets the leading
   `\s*` start inside a whitespace run (`(?:(?<!\s)\s+)?[,]\s*`); lib/messages.js refuses `__proto__` as a
   language code in `compile()` and `merge()`; lib/types/keys.js creates the rename target with
   `Object.create(null)`; dist/joi-browser.min.js is the rebuilt bundle (+172 bytes, the same changes);
   package.json the version. No new risky use. 17.13.9 is the `latest-17` line (wait-on 7.2.0 wants `^17.11.0`;
   the fix for 18.x is 18.3.1).

   After the install: `.npmrc` still min-release-age=7; the lockfile changed in exactly the two packages' entries,
   integrity equal to the registry's; `npm audit`: 0 high / critical (19 moderate remain: minimatch and glob
   through electron-builder and the eslint tooling, not in scope); `npm audit signatures`: ok; the test-only
   packages reinstalled with --no-save, lockfile untouched. tests/npm-audit-clean.test.mjs is green.
3. **pyasn1 0.6.4 -> 0.6.5** (the image and the desktop venv; pulled in by google-auth through pyasn1-modules,
   used when the Google Calendar sign-in parses keys and certificates). GHSA-2qm8-x737-gmw5 / CVE-2026-119196,
   GHSA-9m75-vc3g-4x39 / CVE-2026-119195, GHSA-fm9c-5rcf-2q5p / CVE-2026-119194 and GHSA-mm57-4v3p-rchx /
   CVE-2026-119197 (all High, published 2026-10-30: quadratic CPU use when decoding constructed BIT STRING,
   constructed OCTET / character strings and indefinite-length ANY, binary REAL mantissas, and schemaless
   containers with colliding long tags). Uploaded 2026-10-27 06:32 UTC, 4.3 days old.
   `scripts/verify-pypi-release.py pyasn1 0.6.4 0.6.5 --diff --compare-tag pyasn1/pyasn1@v0.6.5`: no PEP 740
   provenance on either version's files; the release metadata unchanged (author Ilya Etingof, maintainer "pyasn1
   maintenance organization" / Christian Heimes); the project page's maintainer accounts droideck, etingof, ilya,
   tiran; the sdist's and the wheel's sha256 equal to the index's; sdist 155 -> 156 files, 10 changed
   (CHANGES.rst, the two PKG-INFO, SOURCES.txt, `pyasn1/__init__.py` for the version, `pyasn1/codec/ber/decoder.py`,
   four test modules), 1 added (`tests/codec/test_decoder_schemaless.py`); wheel 38 -> 38 files, the same two
   modules and the dist-info metadata; no dependencies before or after, no build-hook change (pyproject.toml
   untouched, no setup.py); the `pyasn1/` tree of the sdist and of the wheel identical to the GitHub tag v0.6.5
   (32 modules); no new subprocess / network / eval / ctypes / env use. The decoder.py diff is the four fixes:
   constructed BIT STRING fragments are assembled into one bytearray with bit-level bookkeeping
   (`_appendFragment`) instead of re-prepending a growing BitString; OCTET STRING / character-string fragments
   and the indefinite-length ANY body are collected in a list and joined once; the REAL mantissa is read with
   `int.from_bytes`; the schemaless container decoder stops adding tag sets after two distinct ones.
   Compatibility: pyasn1-modules 0.4.2 requires `pyasn1<0.7.0,>=0.6.1`, `pip check` is clean, google-auth 2.56.3
   imports, tests/google_calendar_auth.test.py and google-calendar-optional pass. Lock:
   `backend/lock-requirements.sh --past-cooldown pyasn1==0.6.5` (the script ran the verifier first - no red flag -
   and kept the approved exceptions exempt); the lock changed in that one line (plus its cutoff header), and
   `backend/cooldown-exceptions.txt` gained the line with the advisories and dates.
4. **curl-minimal / libcurl-minimal 7.76.1-40.el9_8.8 -> el9_8.9: left as is.** CVE-2026-8932 (Moderate per Red
   Hat, Medium in Grype, non-blocking: libcurl could reuse a pooled connection after mTLS client-certificate
   options changed). `scripts/verify-rpm-update.sh --cve CVE-2026-8932 curl-minimal-7.76.1-40.el9_8.9
   libcurl-minimal-7.76.1-40.el9_8.9`: the fix for RHEL 9 is RHSA-2026:92907, first released 2026-10-30 01:23
   UTC - 1.5 days old at the check, under the lane's 2-day floor, so the Containerfile is unchanged. Everything
   else is in place for when it is old enough: inside the pinned ubi9-minimal base, `microdnf upgrade` brings
   both RPMs to 7.76.1-40.el9_8.9.aarch64, signed RSA/SHA256 on 2026-10-13 with Red Hat's release key 2
   (199e2f91fd431d51), vendor Red Hat, Inc., built 2026-09-24 from curl-7.76.1-40.el9_8.9.src.rpm, and the
   erratum's fixed list carries both packages for aarch64 and x86_64. In the image libcurl serves only the
   HEALTHCHECK's `curl -fsk` to localhost and microdnf at build time; nothing alters client-certificate options
   between transfers. From 2026-11-01 01:23 UTC the pair can be added to the Containerfile's `microdnf ... upgrade
   xz-libs` line with an `rpm -q curl-minimal-7.76.1-40.el9_8.9 libcurl-minimal-7.76.1-40.el9_8.9` check, under
   the lane.

Also run, as the first real use of the new tool: `scripts/verify-go-module.sh golang.org/x/net v0.62.0` confirms
the 2026-10-29 entry - checksum database record 70195880, `h1:18ELalfM5+XNRwzM2nYqXsZQ9ByS1uhj2O/U7+5jqRY=` and
go.mod `h1:WgDCOTH8iwtB66T4/GfI94AHo/hhdb7Hah9NDseQfiI=`, the proxy's time 2026-10-27T19:00:16Z and origin
go.googlesource.com/net at refs/tags/v0.62.0, commit 3de643db506517b3e652a13cc0b56034cea6b8e6; no change.

The gate before and after, on the arm64 image built from this commit (`--vex vex/jacarium-3.7.0.openvex.json
--ignore-states not-fixed,wont-fix --fail-on high`, database 2026-10-31): before, six findings - the four pyasn1
High and the two curl-minimal Medium - and exit 2; after, the two curl-minimal Medium alone and exit 0.


## 2026-11-03 - curl-minimal / libcurl-minimal 7.76.1-40.el9_8.9 (CVE-2026-8932), the security lane

RHSA-2026:92907 (Moderate), released 2026-10-30 01:23 UTC, 4.2 days old when applied - past the lane's 2 days.
Checked with `scripts/verify-rpm-update.sh --cve CVE-2026-8932 curl-minimal-7.76.1-40.el9_8.9
libcurl-minimal-7.76.1-40.el9_8.9` inside the pinned ubi9-minimal base: both RPMs in the erratum's fixed list,
signed RSA/SHA256 with Red Hat's release key 2 (Key ID 199e2f91fd431d51), vendor Red Hat, source
curl-7.76.1-40.el9_8.9.src.rpm - no red flag. Added to deploy/Containerfile's `microdnf ... upgrade` step with an
`rpm -q` assertion of the exact versions.


## 2026-11-03 - minimatch 9.0.9 / 10.2.6 -> 11.0.3 (GHSA-g3hv-75wg-m249), the security lane, a targeted override

The 19 moderate findings of `npm audit` in the root were one advisory: GHSA-g3hv-75wg-m249 / CVE-2026-118764
(Moderate, published 2026-10-30 23:09 UTC) - minimatch's `**/..` transformation in firstPhasePreProcess() clones
glob parts inside a fixpoint loop and the second phase compares them pairwise, so a pattern can cost quadratic
CPU and memory; it runs at `optimizationLevel >= 2` (the default is 1). Fixed in 11.0.1 alone (commit 77a0f5c,
"limit \*\*/.. optimization pass to avoid quadratic explosion", 2026-10-27), nothing on the 3.x / 5.x / 9.x /
10.x lines. The tree had four copies, all dev-only (no production dependency of the app or the central server
uses minimatch): 10.2.6 hoisted (eslint 10.13.0 `^10.2.6`, @eslint/config-array `^10.2.4`, app-builder-lib
`^10.2.5`), 9.0.9 under @electron/universal (`^9.0.3`), 3.1.5 under @electron/asar, glob 7 and dir-compare, 5.1.9
under filelist (jake < ejs < app-builder-lib). Only the 9.x and 10.x copies contain the preprocessing passes
(`grep -rl firstPhasePreProcess node_modules` names exactly those two; the option came with minimatch 7.1), so
those two are replaced and the other two stay, decided `vulnerable_code_not_present` in vex/decisions.yaml. The
upstream releases that would carry the fix (eslint 10.14.0 of 2026-10-30, electron-builder 26.18.0 of
2026-10-29) still pin `^10.2.6` / `^10.2.5`, so no plain upgrade fixes it; npm's suggestion (electron-builder
20.23.1) is a downgrade and was ignored. Ages are as of 2026-11-03 10:40 UTC.

1. **minimatch 11.0.3** (the newest version at least 2 days old: 11.0.4 of 2026-11-02 04:50 UTC was 1.2 days).
   Published 2026-10-28 20:00 UTC, 5.6 days old. `npm run deps:urgent -- minimatch@11.0.3 --reason
   "GHSA-g3hv-75wg-m249" --dry-run --diff`: publisher `isaacs`, the same account as 10.2.6; two registry
   signatures (key SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U, the same as 10.2.6's); no provenance
   (10.2.6 had none); no install script; 10 files changed, 0 added, 16 removed (the `ast.*` and
   `brace-expressions.*` modules are gone - 11.0 matches each path portion with a Matcher instead of a RegExp);
   no new child_process / fs / network / eval / env use. Between 11.0.1 and 11.0.3: a dependency update, a cache
   of the 256 most recent patterns, lazier matcher creation (commits 322feb1, 52d2aec, 293267a).
   **Two red flags, both dependency changes**, on which the script stopped as it should: `brace-expansion
   ^5.0.8 -> ^5.0.12` (5.0.12, published 2026-09-14 by juliangruber, is what the tree already has through the
   existing `brace-expansion: ^5.0.8` override - no new resolution) and the new dependency
   `@isaacs/nonrecursive-glob-match ^1.0.3`, a package first published 2026-10-26 by the same `isaacs`; 1.0.3
   published 2026-10-28 19:50 UTC, 5.6 days old. Reviewed from its tarball (`npm pack` into an empty directory):
   no dependencies, no install script (`prepare` / `prepublishOnly` run only in the author's checkout), the
   files are `dist/` (CommonJS and ESM builds with maps, a minified copy) and `src/` (index.ts 27 KB,
   parse-class.ts 5 KB), 380 KB in all; the only import is its own parse-class.js - no Node built-in, no network,
   no eval; BlueOak-1.0.0; no `repository` field and no provenance, so there is no build to link it to beyond the
   publisher. Lock integrity: minimatch sha512-iny/40PEGkNJQ5/Pv6z3nm6…, nonrecursive-glob-match
   sha512-SI7kyKHq4XXDRozw+r9GlRZ…, both equal to the registry's `dist.integrity`. A new dependency is outside
   what the lane admits on its own ("no new dependency beyond the fix"), so this one is the maintainer's
   decision: the facts are here, the commit that carries it stands alone on the branch.

   **The override is targeted and pinned.** The script's own install would have written the plain key
   `minimatch`, which would also move glob 7's copy to 11 - and glob 7 reads what 11.0 removed (RegExp entries
   in `Minimatch.set`, their `_glob`), as do nothing else; dir-compare and filelist would survive but gain
   nothing. So the entry in package.json is `"minimatch@>=9.0.0": "11.0.3"`, the install was
   `npm install --min-release-age=0` once (.npmrc untouched, still 7), and the version is exact: the first try
   with `^11.0.3` resolved to 11.0.4, 1.2 days old, and was reverted. Lock diff: `node_modules/minimatch`
   (10.2.6) removed; 11.0.3 under @electron/universal (was 9.0.9), @eslint/config-array, app-builder-lib and
   eslint; `@isaacs/nonrecursive-glob-match` 1.0.3 added; nothing else. What the four consumers use of
   minimatch is in 11's API - `new Minimatch(pattern, options)`, `.match(path, partial)`, `.pattern`, `.negate`,
   `.set` read with `typeof entry === 'string'` (app-builder-lib's hasMagic), `minimatch(path, pattern,
   { matchBase: true })` (@electron/universal); none of the removed makeRe / regexp / AST / matchOne / slashSplit
   / debug. Proven: `npm run lint` 0 problems; `npm run build && npx electron-builder --dir` packages
   dist-electron/mac-arm64/Jacarium.app, tests/electron-package-files.test.mjs (21156 asar entries, every
   required file) and tests/packaged-app-smoke.test.mjs (the app launches isolated, reports 3.7.2, answers the
   home-server call) pass; tests/urgent-dep-update.test.mjs and tests/vex.test.py pass.

   After: `npm audit` 0 high / critical, 15 moderate - every one GHSA-g3hv-75wg-m249 through the 3.1.5 / 5.1.9
   copies (minimatch, glob, rimraf, temp, filelist, jake, ejs, dir-compare, @electron/asar, @electron/universal,
   electron-winstaller, electron-builder-squirrel-windows, app-builder-lib, dmg-builder, electron-builder); the
   four ESLint-side findings (eslint, @eslint/config-array, @eslint-community/eslint-utils,
   eslint-plugin-react-refresh) are gone. `npm audit signatures`: 809 verified registry signatures, 152
   attestations. tests/npm-audit-clean.test.mjs now requires every moderate-or-worse advisory to be a
   not_affected decision in vex/decisions.yaml for the next release, naming each copy the lock resolves inside
   the vulnerable range, and keeps this override exact. The override goes when eslint and electron-builder
   require minimatch 11 themselves.

   **Maintainer decision (2026-11-03):** the new transitive dependency `@isaacs/nonrecursive-glob-match` 1.0.3 goes
   beyond the security lane's "no new dependency" rule, so the guarded script stopped; it was reviewed by hand
   (above) and accepted explicitly by the maintainer. Dev tooling only - it is not in the installers or the image.
2. **minimatch 3.1.5 and 5.1.9: left, decided.** No fixed release exists on their lines; the vulnerable passes
   are not in them (checked in node_modules: neither has firstPhasePreProcess, secondPhasePreProcess or
   optimizationLevel). vex/decisions.yaml: the 2026-10-31 statement now covers 3.7.1 and 3.7.2 (the releases
   with all four copies), a new one from 3.7.3 names the two remaining copies as `vulnerable_code_not_present`.


## 2026-11-04 - the container's Node.js 24.22.1 -> 26.13.0 (the maintainer's explicit exception, not the lane)

Node.js 26.13.0 is the first LTS release of the 26 line ("Lithium", released 2026-10-28, npm 11.20.0;
Dependabot #1). **This is not a security fix**, so the security lane does not apply; the maintainer granted an
explicit exception to the seven-day rule for the image on 2026-11-04 (the image was 6.6 days old), and that
is why it is logged here. The image: `docker.io/library/node:26.13.0-bookworm-slim`, pinned by its
manifest-list digest `sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9` in
deploy/Containerfile's UI build stage - the stage whose `node` binary is copied into the runtime image for the
central server - with its two platform manifests `sha256:cd820d60a7f3ae057389f3e1bcf1a0ac09dd57c428fe14f191dcbc5c56ac5fe2`
(amd64, built 2026-10-28 20:55:51 UTC) and `sha256:29b974c22ff1c2508ca4c62da1414429b484a3d2a8f8f32520114c6975991eed`
(arm64, 2026-10-28 20:55:56 UTC), read from Docker Hub's registry (the manifest list and each image's config).
`.nvmrc` moves to 26.13.0 with it: the release workflow's UI build (build.yml, `node-version-file`) and
rebuild.sh read it, so the desktop UI is built with the same Node; Electron runs its own Node and is not
affected. The checks are in the commit that pins it: the arm64 image built with `--timestamp` as build.yml
does and scanned with the Grype gate as build.yml runs it, the container-deploy test, the central server's
(Express 5, Yjs, socket.io) tests on Node 26, `npm ci` / `npm run build` / the electron-builder `--dir`
packaging under Node 26, the reproducible-build, build-platform and workflow tests. `.npmrc` stays at 7.

One thing the first build found: the nodejs.org Node 26 binary links `libatomic.so.1` (the 24 binary did not),
which ubi9-minimal does not carry - the copied `node` failed to load in the runtime image. The runtime stage
now installs `libatomic` (11.5.0-14.el9, ubi-9-baseos-rpms, 26 kB) in its one microdnf step and runs
`node --version` right after the copy, so a binary whose libraries are missing fails the build rather than
the central server's first start.

## 2026-11-05 - the sweep after CVE-2026-115557: Python 3.14.10 in the installers, Electron 45.2.1 (the lane), Go 1.27.3, brotlicffi

The trigger: CVE-2026-115557 (GHSA-x547-2835-q547, Critical, published 2026-10-24) - CPython's `ssl` module gained a
denylist of the compromised eMudhra intermediate certificates, so a chain through one of them is refused whatever
the SSLContext says; fixed in 3.14.10 (and 3.11.18 / 3.12.16 / 3.13.18 / 3.15.2 / 3.16.0). The 4.0.1 **Linux**
installers (x64 and arm64) bundle CPython 3.14.9 in the PyInstaller-built backend; the backend makes outbound TLS
connections with `requests` (the update check against api.github.com, the AI endpoints, Jira, the workflow URL
fetches, Google Calendar), so the denylist matters there.

1. **The installers: `actions/setup-python` pinned to exactly `3.14.10`** (build.yml, one `PYTHON_VERSION` for the
   installers job, every platform). Not a lane update: the release is 10 days old (python.org 2026-10-25, the
   actions/python-versions build `3.14.10-40336797752` of 2026-10-26, with darwin-arm64, linux-x64 and linux-arm64
   builds in the manifest). What went wrong was the range: `python-version: '3.14'` lets setup-python take the
   3.14.x the runner image carries in its tool cache before it downloads anything, and the release run of 4.0.1
   (2026-11-04) shows it - "Successfully set up CPython (3.14.9)" on ubuntu-24.04 and ubuntu-24.04-arm,
   "(3.14.10)" on macos-26, whose image had no 3.14 to reuse. So **the macOS installer was not flagged because it
   really has 3.14.10**; but the macOS SBOM would not have shown it either way - Syft's binary cataloguer sees the
   Linux build's `libpython3.14.so` and lists `pkg:generic/python@3.14.9`, and it does not classify the macOS
   build's Python (the 4.0.1 macOS SBOM has no python package at all). **Windows: no Windows installer is built**
   (build.yml's matrix is linux-x64, linux-arm64, macos-arm64; the Windows targets in the packaging config are
   not built or published), so nothing to fix and nothing to assume. The build now proves the bundle: the frozen
   backend answers `flask-backend --runtime-version` (backend/app_standalone.py, before the app import),
   rebuild.sh compares it with the venv's Python after every PyInstaller build, build.yml fails the installers job
   when it is not the pin, and tests/bundled_python_version.test.py keeps the pin exact, at least 3.14.10, on the
   lock's minor, with the check step in place.
2. **The container: pending at Red Hat.** The runtime image's `python3.14` is 3.14.8-1.el9_8 (RHSA-2026:77021,
   2026-10-08). Red Hat's security data has no record of CVE-2026-115557 at all (the CVE endpoint answers "Not
   Found"; no python3.14 erratum since mentions it), so scripts/verify-rpm-update.sh has nothing to verify and
   no upgrade line is added. Not a VEX candidate: the container's backend makes the same outbound TLS
   connections, and `requests` verifies against certifi's bundle (2026.10.19, the emSign roots still in it), not
   the system store - so the base image's ca-certificates 2026.2.92_v9.0.319-90.3.el9_8 (RHSA-2026:88459,
   CVE-2026-114406, "distrust eMudhra intermediate CA certificates", already in the pinned base) does not reach
   it. Re-check Red Hat's data for a python3.14 erratum before each release; when one appears it goes through
   verify-rpm-update.sh and the microdnf upgrade line like curl did.
3. **Electron 45.1.0 -> 45.2.1, the security lane** (`npm run deps:urgent -- electron@45.2.1 --reason ...`):
   45.2.1 (2026-10-31, 4.9 days old) updates Chromium from 156.0.8078.49 to 156.0.8078.75, which carries the
   Chrome stable fixes of 2026-10-27 (52 CVEs, four Critical: CVE-2026-118306 FileSystem, CVE-2026-118331
   FileAPI, CVE-2026-118348 Skia, CVE-2026-118344 Layout; Electron names no CVE of its own for it). Publisher
   electron-nightly (the same as 45.1.0), 2 registry signatures, no provenance (Electron publishes none; as
   before), the tarball diff is checksums.json, electron.d.ts and package.json (the 275 "removed" files are the
   downloaded binary under node_modules/electron/dist, not part of the tarball). After: .npmrc still
   min-release-age=7; lockfile: 2 entries changed, all the named packages' own, integrity = registry; npm audit:
   0 vulnerabilities; npm audit signatures: ok; test-only packages reinstalled (playwright-core@1.64.1).
   The spell-check dictionaries follow (`--repin --min-age-days 2`, docs/security/spellcheck-dictionaries.md):
   a new zip digest, every file byte for byte the 45.1.0 pin's.

   **A script fix found on the way:** the lane installed `electron@^45.2.1` with `--min-release-age=0`, and npm
   resolved the caret to 45.2.3 - one day old, never assessed (the script then stopped at "electron@45.2.1 is
   not what the lockfile holds (45.2.3)", so nothing unchecked was kept). scripts/urgent-dep-update.cjs now
   installs the exact version (`--save-exact`; an `overrides` entry is exact too), which is what the checks
   assessed; package.json therefore pins `"electron": "45.2.1"`. tests/urgent-dep-update.test.mjs expects the
   exact form.

   Still pending on the Electron line: 45.2.2 (2026-11-03 19:31 UTC; Chromium 156.0.8078.80 with Chrome's
   2026-10-29 fixes - 21 CVEs, one Critical, CVE-2026-76024 MediaStream - and Node 24.22.2, not a security
   release) is lane-eligible from **2026-11-05 19:31 UTC**; 45.2.3 (2026-11-04, backported upstream fixes, no
   advisory named) from 2026-11-06 21:21 UTC.
4. **Go 1.27.2 -> 1.27.3 for the Caddy build** (deploy/Containerfile, golang:1.27.3-alpine of 2026-10-21 pinned by
   digest `sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb`, Alpine 3.24.3): not the
   lane, the toolchain is 16 days old. It is the fix of GO-2026-6809 / CVE-2026-111943 (crypto/x509 distrusts the
   compromised eMudhra intermediates), which vex/decisions.yaml has as not_affected (Caddy here verifies no
   peer certificate); the statement stays for the releases built with 1.27.2 and now says the toolchain moved.
   Verified in the built image: `caddy build-info` shows go1.27.3 and Grype reports nothing against the stdlib
   without the VEX.
5. **brotlicffi 1.2.0.2 -> 1.2.1.0 in backend/requirements.lock** (`backend/lock-requirements.sh
   --upgrade-package brotlicffi`, the regular rule: uploaded 2026-10-22, 14 days old): GHSA-9v8h-qqgm-4m35 /
   PYSEC-2026-4323, the Brotli decoder out-of-bounds write (CVE-2026-111497, "Node2Shell"). OSV flags the lock
   line; nothing of Jacarium's ever installs it - the pin carries the marker `platform_python_implementation ==
   'PyPy'` and every build is CPython (`brotli` 1.2.1, the CPython wheel, was fixed on 2026-10-26). Only the pin
   moved; the rest of the lock is unchanged.

**Looked at and left (eligibility dates):**

- **Caddy 2.11.7 -> 2.11.8** (2026-11-04 01:16 UTC): fixes five repository advisories - GHSA-r766-rf9f-588h (High:
  a `{host}`-based root escaped through dot segments in Host / :authority), GHSA-jf74-f69g-hcj9 (file_server
  serves the data directory when it falls back to ./caddy), GHSA-69hv-5jfc-mvmv (rewrite re-decodes
  `{http.matchers.file.remainder}`), GHSA-25cw-38mq-q7m6 (the file matcher resolves `/file/./` past suffix path
  rules), GHSA-f278-mgc7-46j3 (php_fastcgi authorization bypass). deploy/Caddyfile uses fixed roots (`/app/ui`,
  `/data/ui-assets`), HOME=/data, no rewrite, no php_fastcgi, and its path rules are prefixes over a public UI
  tree, so none of the five reaches this image; no CVE ids yet, nothing in OSV or Grype. **Lane-eligible from
  2026-11-06 01:16 UTC**; the release notes carry breaking changes (idle timeouts, config rejections) to read
  before the bump.
- **ubi9-minimal 9.8-1793578971** (2026-11-02, `sha256:dfa0eb04abc59221544e74862432496add1f491f915c9b531880f91affc0e12c`):
  against the pinned 9.8-1792742033 it carries exactly the xz-libs, curl-minimal and libcurl-minimal builds the
  microdnf upgrade line already installs, plus krb5-libs 1.21.1-10.el9_8.1 (no security erratum names it; Grype
  reports nothing against the pinned base's krb5-libs). Grype on the new base: no findings; on the pinned base:
  the three the upgrade line fixes. A clean-up bump, **from 2026-11-09 under the seven-day rule** - then the
  upgrade line and its `rpm -q` assertions can go.
- **Node.js**: the container's 26.13.0 is the newest 26 (no 26.13.x since 2026-10-28); 24.22.2 (2026-10-27) is not a
  security release and is Electron's concern (45.2.2 carries it); no November security release announced.
- **npm**: both tiers clean in both lockfiles (root and jacarium-central: `--omit=dev` at moderate, full at high);
  no open Dependabot alert.
- **Python**: OSV over the 111 pins of backend/requirements.lock finds only the brotlicffi line above.


## 2026-11-06 - Electron 45.2.2 (the lane), Caddy 2.11.8 (the lane), sqlite CVE-2026-119586 (VEX)

1. **Electron 45.2.1 -> 45.2.2, the security lane** (`npm run deps:urgent -- electron@45.2.2 --reason ...`,
   the exact-pin form). Reason: CVE-2026-76024 (Critical, use after free in MediaStream), CVE-2026-76025,
   CVE-2026-76026, CVE-2026-76027, CVE-2026-76028, CVE-2026-76029 (High) - Chrome's stable fixes of
   2026-10-29 (156.0.8078.79, 21 CVEs), carried by 45.2.2's Chromium 156.0.8078.80; 45.2.2 also takes Node
   24.22.2 (not a security release). Published 2026-11-03 21:43 UTC, 2.0 days old; publisher electron-nightly
   (as 45.2.1), 2 registry signatures, no provenance (Electron publishes none), the tarball diff is
   checksums.json, electron.d.ts and package.json. After: .npmrc still min-release-age=7; lockfile: 2 entries
   changed, all the named packages' own, integrity = registry; npm audit: 0 vulnerabilities; npm audit
   signatures: ok; test-only packages reinstalled (playwright-core@1.64.1), lockfile untouched; package.json
   pins `"electron": "45.2.2"`. The spell-check dictionaries follow (`--repin --min-age-days 2`,
   docs/security/spellcheck-dictionaries.md): a new zip digest, every file byte for byte the 45.2.1 pin's.
   **Not 45.2.3** (2026-11-04, backported upstream fixes, no advisory named): the seven-day rule, 2026-11-11.
2. **sqlite CVE-2026-119586, a VEX statement, no upgrade** (Red Hat: Important, sqlite-libs 3.34.1-11.el9_8
   "Affected", no fix; Grype reports it as not-fixed, so the gate ignores it). The flaw is a command injection
   in the sqlite3 command-line shell's `.recover` output (shell.c); the image has only sqlite-libs - no
   `sqlite` RPM, no `/usr/bin/sqlite3`, `command -v sqlite3` finds nothing - and the backend uses the library
   through Python's sqlite3 module. vex/decisions.yaml: not_affected, vulnerable_code_not_present, from 4.1.0,
   for `pkg:rpm/redhat/sqlite-libs@3.34.1-11.el9_8`. deploy/Containerfile's runtime stage now fails the build
   if `sqlite3` or the `sqlite` RPM appears, the container-deploy test checks the running container, and
   tests/container_reproducible.test.py keeps the Containerfile check. Red Hat lists its nodejs RPMs as
   affected too (they bundle SQLite); the image's Node is the nodejs.org 26.13.0 binary, whose `node:sqlite`
   (SQLite 3.54.0) exposes DatabaseSync / StatementSync / Session / backup and nothing like `.recover` or the
   shell's dot-commands - library code, the same reading; the central server does not use it anyway.

3. **Caddy 2.11.7 -> 2.11.8, the security lane** (`scripts/verify-go-module.sh github.com/caddyserver/caddy/v2 v2.11.8`,
   run 2026-11-06 01:17 UTC): checksum database record 70750915, `h1:E2pv1BoZ5bJaWqFkU6QvLa21iGAX8bDzlEQG4dDQ/Vc=`
   (go.mod `h1:r8BAzVRMkDEgSi6ckDR57rxeGvylYFeGZZZ8ut7N5hQ=`), proxy time 2026-11-03 23:25 UTC (2.1 days old), origin
   the tag refs/tags/v2.11.8 at 55996dfe05c10bb616ccdcc9bf5b8407a5be75b7 of github.com/caddyserver/caddy; no red flag.
   The release fixes GHSA-r766-rf9f-588h (High, a `{host}`-based root escaped by dot segments) and
   GHSA-jf74-f69g-hcj9, GHSA-25cw-38mq-q7m6, GHSA-69hv-5jfc-mvmv, GHSA-f278-mgc7-46j3 (Medium). None reaches the
   image's configuration: deploy/Caddyfile has fixed roots (/app/ui, /data/ui-assets) with HOME=/data, no `{host}`
   placeholder, no rewrite and no php_fastcgi, and its only path rules are prefix excludes over the public UI tree;
   its breaking changes (an invalid Host gets 400, a trailing-slash `file` candidate matches only a directory,
   `encode` ignores a request's no-transform, stricter validation of options this config does not use) change
   nothing here. Taken so the image carries no Caddy release with an open advisory. Not 2.11.9 (2026-11-05 01:30
   UTC: FastCGI hardening and a fix of 2.11.8's PHP-index regression, neither used here): next, from the lane's
   2026-11-07 01:30 UTC.

## 2026-11-07 - Caddy 2.11.8 -> 2.11.9, the security lane

`scripts/verify-go-module.sh github.com/caddyserver/caddy/v2 v2.11.9` (run 2026-11-07 01:31 UTC): checksum database
record 70814862, `h1:bhZtcRKQOq0fuLvEgCdPYvUxXyGn9kzjG4lh2332DTE=` (go.mod
`h1:jctG0eTy0tC4ST/Q7GIPKIfxox7mhSCtcwlwF82HLVM=`), proxy time 2026-11-04 23:05 UTC (2.1 days old), origin the tag
refs/tags/v2.11.9 at 0d98caea58f794f88e709b1bef2880996a471bca of github.com/caddyserver/caddy; no red flag. The
release is a follow-up to 2.11.8: the fix of 2.11.8's PHP directory-index regression and FastCGI hardening,
placeholders in path matchers compared case-insensitively, and backported fixes. deploy/Caddyfile uses no
php_fastcgi, no path-matcher placeholders and no file_server browse; taken so the image stays on Caddy's current
release with no open advisory. The Containerfile's build asserts the version (`caddy version`), and the pins of
x/net, chi, go-jose and klauspost/compress stay as they are.

## 2026-11-08 - glibc 2.34-284.el9_8.4 (RHSA-2026:95618), the security lane

The fresh Grype database of 2026-11-07 reported CVE-2026-8674 (the DNS stub resolver: a denial of service through a
long search domain in the configuration) and CVE-2026-89092 (an nscd stack overflow) against the base image's
glibc 2.34-283.el9_8; the erratum also fixes CVE-2026-86805 and CVE-2026-95818. Moderate; the image does not run
nscd, and its resolver configuration is the container runtime's, but the fix is taken so the image carries no
fixable glibc advisory. `scripts/verify-rpm-update.sh --cve CVE-2026-8674 --cve CVE-2026-89092
glibc-2.34-284.el9_8.4`, run 2026-11-08 07:46 AEST once the erratum was two days old (at 1.9 days, 06:15, it
correctly refused):

```
== CVE-2026-8674: public 2026-09-17T16:54:27Z severity Moderate
   Red Hat Enterprise Linux 9: RHSA-2026:95618 2026-11-05T00:00:00Z glibc-0:2.34-284.el9_8.4
== CVE-2026-89092: public 2026-09-11T01:23:01Z severity Moderate
   Red Hat Enterprise Linux 9: RHSA-2026:95618 2026-11-05T00:00:00Z glibc-0:2.34-284.el9_8.4
== RHSA-2026:95618: Red Hat Security Advisory: glibc security update
   released 2026-11-05T21:43:56+00:00 severity Moderate cves CVE-2026-8674,CVE-2026-86805,CVE-2026-89092,CVE-2026-95818
   age 2.0 days
   fixed: glibc-2.34-284.el9_8.4: aarch64, i686, ppc64le, s390x, src, x86_64
== registry.access.redhat.com/ubi9-minimal:9.8-1792742033@sha256:2d4c4551af6831dcd26bbf86108c4385de5183ec8fe6b5868f6f9640fe47f4ed: microdnf upgrade glibc
   glibc-2.34-284.el9_8.4.aarch64: signature RSA/SHA256, Fri Oct 30 22:08:29 2026, Key ID 199e2f91fd431d51
   vendor Red Hat, Inc., built Fri Oct 23 09:37:00 2026, source glibc-2.34-284.el9_8.4.src.rpm

no red flag
```

deploy/Containerfile's runtime stage upgrades `glibc glibc-common glibc-minimal-langpack` in its one microdnf
line and checks the exact versions with `rpm -q`; tests/container_reproducible.test.py names them among the
packages raised past the pinned base. The ubi9-minimal base bump due from 2026-11-09 will carry these and lets the
upgrade line go.


## 2026-11-09 - base image ubi9-minimal 9.8-1793578971: xz-libs and curl leave the upgrade line

The ordinary base bump (no exception: the build is from 2026-11-02 00:22 UTC, seven days old on 2026-11-09;
the 2026-11-05 and 2026-11-09 builds stay inside the rule). deploy/Containerfile's two ubi9-minimal stages
move from 9.8-1792742033 to 9.8-1793578971, pinned by the manifest-list digest
sha256:dfa0eb04abc59221544e74862432496add1f491f915c9b531880f91affc0e12c (the Docker-Content-Digest the
registry answers for the tag with the manifest-list media type; podman's RepoDigests agree; the list carries
amd64, arm64/v8, s390x and ppc64le). Against the previous base its 109 RPMs differ in three packages:
xz-libs 5.2.5-8.el9_0 -> 5.2.5-8.el9_8.1 (CVE-2026-34743, the lane item of 2026-10-29), curl-minimal /
libcurl-minimal 7.76.1-40.el9_8.8 -> 7.76.1-40.el9_8.9 (the lane item of 2026-10-30) and krb5-libs
1.21.1-10.el9_8 -> 1.21.1-10.el9_8.1. So `microdnf ... upgrade` and the `rpm -q` asserts drop xz-libs,
curl-minimal and libcurl-minimal - the base carries exactly the versions the asserts named - and keep glibc,
glibc-common and glibc-minimal-langpack: this base still has glibc 2.34-283.el9_8, the lane's 2.34-284.el9_8.4
(RHSA-2026:95618, 2026-11-08 above) is newer than it. tests/container_reproducible.test.py's allow-list of the
packages raised past the base is the three glibc packages now.
