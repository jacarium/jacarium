# Security policy

Security is a priority in Jacarium. Thank you for helping keep it and its
users safe.

## Reporting a vulnerability

**Please don't report security issues in public issues, discussions or
pull requests.**

Report them privately through GitHub instead:
[**Report a vulnerability**](https://github.com/jacarium/jacarium/security/advisories/new)
(the "Security" tab of the repository, then "Report a vulnerability").

Please include:

- what the issue is and what an attacker could do with it;
- the steps to reproduce it, or a proof of concept;
- the version of Jacarium (Settings > About) and where it runs: the desktop
  app (and your operating system) or a self-hosted server.

I'll acknowledge your report within 3 days, keep you updated while I work
on a fix, and credit you in the release notes if you'd like. A High or
Critical issue gets a fix release within 30 days of the report; lower
severities go into the next regular release. Please give me that time before
disclosing the issue publicly.

## Supported versions

Security fixes go into the latest release. Please update to it before
reporting, in case the issue is already fixed.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |

## How Jacarium is kept secure

- **Vulnerability scanning.** Jacarium is scanned against known
  vulnerabilities and kept up to date. Its own code is checked too, not only
  the packages it relies on.
- **Software supply chain.** Every dependency, and its dependencies, is
  checked: scanned for vulnerabilities and end-of-life software, and
  verified against its licence. The controls are listed below.
- **Privacy checks.** Every release is scanned so that no personal data,
  secrets or real screenshots end up in the published source.
- **Tests.** Jacarium is built test-first, with tests for its security
  checks, sign-in and data isolation between accounts - and for the
  supply-chain controls themselves (`tests/github_workflows.test.py`,
  `tests/release_sign.test.py`).

## Supply-chain controls

What a release of Jacarium is made of, and how you can check it. The
"Verify this release" block in [README.md](README.md#security--supply-chain)
has the copy-paste commands.

| Control | What it is |
|---|---|
| **Build provenance, SLSA Build L3** | The installers, the container image and the SBOMs are built by the reusable workflow [`.github/workflows/build.yml`](.github/workflows/build.yml) on GitHub-hosted runners. The build jobs have no signing permission; a separate job that runs no project code signs the provenance (GitHub artifact attestations, Sigstore). `gh attestation verify --signer-workflow jacarium/jacarium/.github/workflows/build.yml` pins that builder. |
| **SBOMs** | SPDX and CycloneDX JSON for every installer platform and every image architecture, generated with Syft, attached to the release and attested (`--predicate-type https://spdx.dev/Document/v2.3`). The image's full SPDX lists every file (~18 MB) and exceeds the 16 MiB attestation limit, so the attested SBOM of each image is its package-level copy, `...image-<arch>.packages.spdx.json` (every package, licence, PURL and package relationship, no file entries; `filesAnalyzed: false`), attached next to the full documents. |
| **Image signatures** | The pushed manifest list and both architecture images are signed with cosign, keyless (GitHub OIDC, Fulcio, Rekor); the certificate identity is the reusable workflow at the release tag. The SPDX SBOM is also attached to the image as a cosign attestation. |
| **Verified before publishing** | The release job verifies every attestation with the GitHub CLI before the draft release is created; a release whose attestations do not verify is not created. |
| **Offline verification** | Every attested release file has its Sigstore bundles attached beside it as `<file>.intoto.jsonl` (one per line: the provenance, and for an installer the SBOM and VEX attestations), verified from disk by the release job before they are attached, so `gh attestation verify <file> --bundle <file>.intoto.jsonl ...` needs no access to GitHub's attestation store. The same files are what the OpenSSF Scorecard's Signed-Releases check reads (asset names only). Releases before 3.4.8 received theirs through `scripts/backfill-release-bundles.sh`, which verifies every bundle the same way before uploading it. `slsa-verifier` does not read these bundles (its `verify-artifact` takes the slsa-github-generator's provenance, and it is no longer maintained); the GitHub CLI is the verifier. |
| **Signed source** | The release commit and tag in the public repository are signed with SSH; the public keys are in [`.github/allowed_signers`](.github/allowed_signers): `git -c gpg.ssh.allowedSignersFile=.github/allowed_signers verify-tag vX.Y.Z`. |
| **Pinned, verified tooling** | GitHub's own actions (`actions/*`, `github/codeql-action`) and one explicit exception, `ossf/scorecard-action` in `scorecard.yml` (the only way to publish Scorecard results, which the badge needs), each pinned to a full commit; `tests/github_workflows.test.py` fails on anything else. Third-party tools (Syft, cosign, Grype, OSV-Scanner) run as pinned binaries whose sha256 is recorded in [`.github/tools.env`](.github/tools.env) and whose upstream signature or SLSA provenance is checked before use - never `curl \| sh`. |
| **Code scanning** | CodeQL (JavaScript / TypeScript and Python, the security-extended queries) on every push and pull request to main and weekly; the OpenSSF Scorecard weekly and on every push, published to api.scorecard.dev. Dependabot proposes version updates with a seven-day cooldown. |
| **Vulnerability scanning** | OSV-Scanner over the three lock files on every push and pull request (a finding fails the job unless the VEX says it does not apply); Grype over the image archives at build time, failing on High / Critical findings with a fix the VEX does not cover (findings without a fix in RHEL are reported, not blocking); a weekly Grype re-scan of the latest release's SBOMs against the current database, with the findings in one tracking issue - a CVE published after a release is flagged without a rebuild. |
| **VEX** | An [OpenVEX](https://openvex.dev) document per release, `jacarium-X.Y.Z.openvex.json`, generated by `scripts/vex.py` from the reviewed [`vex/decisions.yaml`](vex/decisions.yaml) and validated against the OpenVEX 0.2.0 schema: `not_affected` only with a justification verified in the code or the deployment, `affected` with the pending fix named. Attached to the release, attested on every installer (`--predicate-type https://openvex.dev/ns/v0.2.0`) and on the image (also as a cosign attestation); the scanners read it. |
| **Dependency policy** | No package version younger than 7 days is installed (`.npmrc` `min-release-age`, `backend/lock-requirements.sh`, pip `--uploaded-prior-to`); base images are pinned by digest and at least a week old. A security fix younger than that is installed only on an explicit decision, after a publisher / provenance / diff review that is logged in [`docs/security/urgent-updates.md`](docs/security/urgent-updates.md). |
| **Least privilege** | Every workflow job declares its own permissions; no secret is stored for the registry (the Quay robot is federated with the workflow's OIDC identity). |

| **Reproducible image build** | Two builds of the same commit produce the same layers except one: the rpm database's install times in the `dnf -y install` layer (measured file by file, `docs/security/reproducible-builds.md`). A weekly workflow rebuilds the current commit twice and fails on any other difference. The desktop installers are not reproducible and are not claimed to be; their provenance is what makes them verifiable. |

Everything above is in place; nothing is claimed early. What is not done:
fuzzing (no fuzz targets in this codebase yet) and reproducible desktop
installers.

## Running Jacarium securely

Jacarium is offline by default. The only network request the app can make on
its own is the optional update check (off by default, Settings > About): a
plain request to api.github.com for the list of releases, with nothing about
you or your installation in it.

If you self-host it:

- For access away from home, connect to your home server through your own
  VPN. Never publish its port on the internet.
- Traffic is encrypted, but stored data isn't, so use disk encryption such as
  FileVault or LUKS.
- Keep the app and your server on the latest release.
- You run and secure your installation yourself; Jacarium is provided
  without warranty under the [AGPL-3.0 licence](LICENSE).

The self-hosting guide has the details:
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).
