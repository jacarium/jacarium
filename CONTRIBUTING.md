# Contributing to Jacarium

Thanks for helping. Jacarium is maintained by one person, so the process is
small; this page says what it is.

## Reporting bugs and asking for features

[Open an issue](https://github.com/jacarium/jacarium/issues): what you did,
what you expected, what happened, the Jacarium version and whether it is
the desktop app or the self-hosted container.
Attach logs or screenshots only after removing hostnames, IP addresses,
cluster names and anything else from your environment.

Issues are public and stay public (closed ones included), so they double as
the project's bug archive. Every report gets an answer; most within a week.

**Security issues are different:** never in a public issue - report them
privately as described in [SECURITY.md](SECURITY.md).

## Contributing a change

1. **Open an issue first** for anything bigger than a typo, so we can agree
   on the approach before you write the code.
2. Fork the repository and make the change on a branch.
3. **Add or update tests.** New functionality comes with automated tests
   that exercise it, and a bug fix comes with a test that fails without the
   fix (see [Tests](#tests)). A change without tests is not merged.
4. Run the tests and the linter (below) and make sure they pass.
5. Open a pull request against `main` that says what changed and why, and
   links the issue.

The public repository is published from the maintainer's working
repository at every release: an accepted pull request is applied there,
reviewed, and appears here with the next release (the release commit and
tag are SSH-signed, see [SECURITY.md](SECURITY.md)). You are credited in
the release notes unless you would rather not be.

By contributing you agree that your contribution is licensed under the
project's licence, the [GNU AGPL v3.0](LICENSE).

## Coding standards

- **Match the surrounding code**: its naming, its comment density, its idiom.
  JavaScript / React follows `eslint.config.js` (`npm run lint` must be
  clean); Python follows the style of the module you are in.
- **UI changes** use the shared theme tokens and components, never one-off
  styling.
- **Dependencies**: nothing younger than 7 days (npm `min-release-age`, the
  Python lock - see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)); a new
  dependency needs a reason in the pull request.
- **Test data is synthetic**: documentation IP ranges (192.0.2.0/24,
  198.51.100.0/24, 203.0.113.0/24), `example.com`, made-up cluster and host
  names - never data from a real environment.
- **Security**: think about untrusted input (uploaded archives, logs and
  manifests are untrusted), don't log secrets, and keep the least privilege
  the code already has.

## Tests

```bash
npm ci
npm run lint            # ESLint, must be clean
./tests/run-all.sh      # every test (JavaScript and Python)
```

A single test runs on its own: `node tests/<name>.test.mjs` or
`backend/venv/bin/python tests/<name>.test.py`. More in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Releases and versions

Versions follow [Semantic Versioning](https://semver.org): a patch release
for fixes and security updates, a minor release for new features, a major
release when users must act. Every release has notes in
[CHANGELOG.md](CHANGELOG.md) (and the app's What's New); a release that
fixes a publicly known vulnerability names it there by its identifier (CVE,
GHSA or similar), and the release's [OpenVEX](https://openvex.dev) document
records its status.

The public `main` is not only releases: between releases it receives
development snapshots of the maintainer's main (`Development snapshot: main
@ <sha> (after vX.Y.Z)` commits, signed like the releases), so the work in
progress is there to review. Releases are the tagged commits `Jacarium
X.Y.Z`.
