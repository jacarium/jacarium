# GitHub settings for the public repository

What the workflows and the policy in SECURITY.md expect on github.com/jacarium/jacarium; nothing here is set by
a script - the maintainer sets it once in the repository's Settings. Checked against the supply-chain controls
on 2026-10-26.

## Actions

- Settings > Actions > General > Actions permissions: **Allow jacarium, and select non-jacarium, actions and
  reusable workflows**, with **Allow actions created by GitHub** ticked (covers `actions/*` and
  `github/codeql-action`) and, under "Allow specified actions and reusable workflows", exactly one pattern:
  `ossf/scorecard-action@fa7117db83c52d787ae5a89f350999701505d78e` (the SHA the workflow pins; use
  `ossf/scorecard-action@*` only if the SHA form is refused). Nothing from the Marketplace.
- Workflow permissions: **Read repository contents and packages permissions** (the default `GITHUB_TOKEN` is
  read-only; every job declares what it needs), and "Allow GitHub Actions to create and approve pull requests"
  off.
- Fork pull request workflows: require approval for all outside collaborators.

## Environments

- `quay`: required reviewers = the maintainer; deployment branches and tags limited to tags `v*`. Secrets:
  **none** - remove `QUAY_USERNAME` and `QUAY_TOKEN` (the keyless exchange with the federated robot
  `zerodayz+github_release` is the only sign-in; subject `repo:jacarium/jacarium:environment:quay`).

## Rules (Settings > Rules > Rulesets)

- Tags `v*`: restrict creations, updates and deletions to the maintainer (the release script pushes signed tags
  only); require signed tags is not a GitHub option - the signature is verified by `scripts/publish-release.sh`
  before the push and by anyone with `.github/allowed_signers`.
- Branch `main`: block force pushes and deletions; require signed commits (the release commits are SSH-signed;
  GitHub shows "Verified" once the signing key's public half is added to the maintainer's account as a
  **signing key**, Settings > SSH and GPG keys); require a pull request with "Require review from Code Owners"
  if changes ever arrive as pull requests (CODEOWNERS covers `.github/`, the release and export scripts,
  `deploy/`, `packaging/`, the lock files).

## Code security (Settings > Code security)

- Private vulnerability reporting: on (SECURITY.md points reporters there).
- Dependabot: alerts on, security updates on, version updates on (reads `.github/dependabot.yml`; the seven-day
  cooldown is in the file). Dependabot's pull requests are reviewed like any other; the lock files are
  regenerated with the project's scripts, never taken as Dependabot wrote them.
- Code scanning: no default setup; the CodeQL, Scorecard, OSV-Scanner and Grype workflows upload their SARIF
  themselves. Secret scanning and push protection: on.

## Account

- The release signing key's public half added to the maintainer's GitHub account as a signing key, so the
  signed tags and commits show as "Verified" on github.com (verification by others uses
  `.github/allowed_signers`, not GitHub).
- Two-factor authentication on the account (Scorecard's and the Best Practices badge's expectation).

## After the first release with the new workflows

- Register the project at https://www.bestpractices.dev and put the badge id into README.md (the commented
  placeholder).
- Check https://scorecard.dev/viewer/?uri=github.com/jacarium/jacarium after the first Scorecard run on main.
