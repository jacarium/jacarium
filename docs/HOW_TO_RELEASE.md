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
