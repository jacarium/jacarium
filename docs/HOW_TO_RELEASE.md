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

