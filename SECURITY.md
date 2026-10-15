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

I'll acknowledge your report as soon as I can, keep you updated while I work
on a fix, and credit you in the release notes if you'd like. Please give me a
reasonable time to release a fix before disclosing the issue publicly.

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
  verified against its licence.
- **Privacy checks.** Every release is scanned so that no personal data,
  secrets or real screenshots end up in the published source.
- **Tests.** Jacarium is built test-first, with tests for its security
  checks, sign-in and data isolation between accounts.

## Running Jacarium securely

Jacarium is offline by default. If you self-host it:

- For access away from home, connect to your home server through your own
  VPN. Never publish its port on the internet.
- Traffic is encrypted, but stored data isn't, so use disk encryption such as
  FileVault or LUKS.
- Keep the app and your server on the latest release.
- You run and secure your installation yourself; Jacarium is provided
  without warranty under the [AGPL-3.0 licence](LICENSE).

The self-hosting guide has the details:
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).
