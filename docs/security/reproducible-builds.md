# Reproducible builds

Can the container image be rebuilt bit for bit from the same commit? Almost: every layer but one, and the one
is known, explained and measured file by file. The desktop installers are not reproducible and are not claimed
to be (below).

## The container image

Measured on 2026-10-26 (podman 5.3, arm64, `deploy/Containerfile` on the SLSA L3 branch, then on the
`ubi9/python-314` base), the same tracked tree built twice from scratch (`--no-cache`), the two images compared
layer by layer, the differing layers' tarballs compared file by file (`podman save`, then every member's size,
mode, owner, mtime and content hash):

| build | identical layers | what differed, by file |
|---|---|---|
| as it was | 4 of 19 (the base image's) | every layer: the build's wall-clock time in every file's mtime |
| with `--timestamp 0` | 17 of 19 | the `dnf -y install` layer: `var/lib/rpm/rpmdb.sqlite` (install times), `var/lib/dnf/repos/*/countme` (dnf's countme cookie), `var/log/rhsm/rhsm.log`, the dnf logs and history; the `pip install` layer: 406 `.pyc` files - pip's own, compiled at `pip install --upgrade pip` with the source mtime in their header |
| with `--timestamp` and the fixes below | 18 of 19 | the `dnf -y install` layer only, and in it only `var/lib/rpm/rpmdb.sqlite`: the rpm database records the second each package was installed (`rpm -q --qf '%{INSTALLTIME}'`), which no option fixes |
| on `ubi9-minimal` (3.5.2, measured 2026-10-29) | 16 of 17 | the `microdnf install` layer only, and in it only `var/lib/rpm/rpmdb.sqlite` (the first comparison also showed `var/cache/ldconfig/aux-cache`, since removed in the same step) |

The fixes, in `deploy/Containerfile`:

- pip is pinned (`pip==26.2.1`) instead of "whatever is newest at build time", and installed with
  `--no-compile` like the application packages; afterwards `python -m compileall -f --invalidation-mode
  unchecked-hash` over both site-packages directories (`lib` and `lib64`) writes bytecode that carries a hash of
  its source and no time, and is never re-validated - an immutable image does not need that;
- after the `microdnf install` (the `dnf -y install` of the earlier base): `/var/cache/yum` (microdnf's
  repository metadata and solv files), `/var/log/dnf*`, `/var/log/hawkey.log`, `/var/lib/dnf/history.sqlite*`,
  `/var/log/rhsm`, `/var/lib/dnf/repos/*/countme` and `/var/cache/ldconfig/aux-cache` (the scriptlets' ldconfig
  run writes inode numbers and times into it; the loader does not read it) are removed - the two-build
  comparison on `ubi9-minimal` found that last file as the only other difference next to the rpm database;
- every build passes `--timestamp` with the commit's time (`git log -1 --format=%ct`): the release workflow
  (`.github/workflows/build.yml`), `deploy/deploy-podman.sh` and the check below. The image's `created` time
  and every file's mtime are then the commit's, not the build's. (`deploy/deploy-to-host.sh` builds on the
  target host from an exported tree and does not pass it; that path is for the home server, not the published
  image.)

What stays: the rpm database of the runtime stage differs by the install times of the packages the Containerfile
adds (since 3.5.2, on `ubi9-minimal`: `python3.14`, `python3.14-libs`, `python3.14-pip-wheel`, `openssh-clients`,
`sshpass`, `openssl` and their dependencies, and the raised `xz-libs`; before, on `ubi9/python-314`:
`epel-release`, `openssh-clients`, `sshpass`, `openssl`); the layer's digest therefore differs, and so does
the image id. Removing the rpm database is not an option (scanners and `rpm -q` read it); setting the time is not
one either (rpm has no `SOURCE_DATE_EPOCH` for install times). Moving those packages out of the image would make
it reproducible; that is a product decision, not taken.

`.github/workflows/reproducible.yml` builds the current commit twice every Saturday (and on request) and compares
the layers: the one layer allowed to differ is the first layer after the base image's (the microdnf step; the
base's layer count is read from the pinned base image, not from the history), any other difference fails the job, and
the summary lists every layer. To run the check by hand:

```bash
epoch="$(git log -1 --format=%ct)"
platform="linux/$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"   # always named: see below
for n in 1 2; do podman build --platform "$platform" --no-cache --format docker --timestamp "$epoch" -f deploy/Containerfile -t "localhost/jacarium:repro-$n" .; done
diff <(podman image inspect --format '{{json .RootFS.Layers}}' localhost/jacarium:repro-1 | tr , '\n') \
     <(podman image inspect --format '{{json .RootFS.Layers}}' localhost/jacarium:repro-2 | tr , '\n')
# which files differ inside a layer: save both images and compare that layer's tar member by member
```

Every build names its platform (`--platform linux/arm64` or `linux/amd64`) and checks the result's
architecture: a digest-pinned `FROM` resolves to whichever architecture's copy of the base image the local
store holds, and after an emulated build that is the other one - 3.4.0's first deploy to the home server
shipped an amd64 image that way (exec format error, rolled back by the health check). `scripts/lib.sh`
(`host_image_platform`, `check_image_arch`), the deploy scripts, the workflows and the container test all do
it; `tests/build_platform.test.py` keeps it so.

Dependencies are exact (`package-lock.json` with `npm ci`, `backend/requirements.lock`, pip pinned, base images
by digest, Taskwarrior by checksum), so the inputs of a build are fixed by the commit; the UI build (Vite), the
central server's `npm ci`, the Taskwarrior build and every COPY layer produced identical layers in every
measurement once the timestamps were fixed.

## The desktop installers

Not reproducible, and not measured in depth: electron-builder's `.dmg`, `.AppImage`, `.deb` and `.rpm` embed
build times, and the PyInstaller bundle of the backend embeds the build's file order and timestamps. What the
release does instead is to make the build itself verifiable: every installer carries SLSA Build L3 provenance
naming the commit and the workflow that produced it, and its SBOM. Reproducibility of the installers would need
`SOURCE_DATE_EPOCH` support through electron-builder and PyInstaller and a normalised packaging step; it is not
on the list.
