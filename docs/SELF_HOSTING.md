# Self-hosting

Running Jacarium in a browser from a container, and deploying it to another
machine such as a Raspberry Pi (the home server).

## Quick start with the published image

Each release is published as a container image for amd64 and arm64 at
`quay.io/zerodayz/jacarium` - `:latest` and one tag per version, e.g.
`:3.1.8` (built on GitHub from the release tag, with build provenance you
can verify - see the end of this section). One container holds
everything (the UI, the backend, the central server for the team features
and Caddy for HTTPS), and everything it keeps lives on one volume, `/data`.

**Podman** (rootless is fine; `:Z,U` labels the directory and gives it to
the container's user):

```bash
mkdir -p ~/.config/jacarium/server/data
podman run -d --name jacarium --hostname jacarium --restart unless-stopped \
  -p 127.0.0.1:8443:8443 \
  -v ~/.config/jacarium/server/data:/data:Z,U \
  quay.io/zerodayz/jacarium:latest
```

**Docker** (a named volume gets the right owner by itself; a bind-mounted
directory must belong to uid 1001: `sudo chown -R 1001:0 <dir>`):

```bash
docker volume create jacarium-data
docker run -d --name jacarium --hostname jacarium --restart unless-stopped \
  -p 127.0.0.1:8443:8443 \
  -v jacarium-data:/data \
  quay.io/zerodayz/jacarium:latest
```

**First sign-in.** Sign-in is on by default (`JACARIUM_AUTH_MODE=accounts`):
the first start prints a one-time setup code that creates the administrator.
Read it with `podman logs jacarium` (or `docker logs jacarium`); it is also
in the volume as `setup-code` (`<data>/setup-code`, or
`docker exec jacarium cat /data/setup-code` with a named volume). Then open
<https://localhost:8443>. The certificate is self-signed (generated on the
first start into `<data>/certs/cert.pem` and `key.pem`, for `localhost` and
`127.0.0.1`), so the browser warns once; accept it, or import `cert.pem` as
trusted. To use your own certificate, put `cert.pem` and `key.pem` in
`<data>/certs` before the first start.

**Sharing it on your network.** `-p 127.0.0.1:8443:8443` publishes it on this
machine only. To reach it from other devices, publish it on the machine's
LAN address and add that address (and a name, if you use one) to the
certificate so the browser's warning is about a self-signed certificate
only, not a wrong name:

```bash
  -p 192.168.1.20:8443:8443 \
  -e TLS_SAN="IP:192.168.1.20,DNS:jacarium.lan" \
```

(`TLS_SAN` is read when the certificate is generated, so set it before the
first start, or delete `<data>/certs/*.pem` and restart.) For access away
from home, connect through your own VPN rather than publishing the port on
the internet; traffic is encrypted, stored data is not, so use disk
encryption (FileVault, LUKS) on the host. `--hostname jacarium` names the
server in each browser's sync identity; keep it the same across updates.

**Updating.** Pull the new image and recreate the container; the volume
keeps everything (the hashed UI files of the previous build are kept on it
for one update, so an open tab keeps working):

```bash
podman pull quay.io/zerodayz/jacarium:latest
podman stop jacarium && podman rm jacarium
podman run -d --name jacarium ...     # the same command as the first time
```

(`docker` works the same way.) To stay on one version, use its tag instead
of `:latest`.

**Backups.** The `/data` volume is the backup: the accounts database
(`accounts.sqlite`), every account's files under `users/`, the settings
(`.jacarium.env`, API keys included - keep it private), the certificate
(`certs/`), the reports Diagnostics browses (`reports/`) and the central
server's state (`central/data` and `central/keys` - without
`keys/yjs-encryption.key` the shared documents are unreadable). Stop the
container, copy the directory (or the named volume's contents), start it
again. Restoring is the reverse.

**Verifying the image.** Each image is built on GitHub from the release tag
and its build provenance is recorded there:

```bash
gh attestation verify oci://quay.io/zerodayz/jacarium:3.1.8 --repo jacarium/jacarium
```

The rest of this page is about building the image yourself and deploying it
to another machine.

## Running in a browser (container)

The desktop app is the primary way to use Jacarium. The same code
also runs as a server: **one container** with the built UI, the Flask
backend, the central server (the team features, `jacarium-central/`, Node)
behind `/central`, and Caddy in front (HTTPS), opened in any modern
browser. Build and run it with Podman (Docker works the same way with
`deploy/Containerfile`):

```bash
# build the image and start it on https://127.0.0.1:8443 (this machine only)
deploy/deploy-podman.sh

# share it on your LAN instead (see the warning below)
BIND_ADDRESS=192.168.1.20 TLS_SAN="IP:192.168.1.20,DNS:console.lan" deploy/deploy-podman.sh

deploy/deploy-podman.sh status | logs | stop | restart | clean
```

By hand, the same thing is:

```bash
podman build -f deploy/Containerfile -t jacarium:latest .
mkdir -p ~/.config/jacarium/server/data
podman run -d --name jacarium --restart unless-stopped \
  -p 127.0.0.1:8443:8443 \
  -v ~/.config/jacarium/server/data:/data:Z,U \
  jacarium:latest
```

The image is built from pinned base images (UBI 9 Python 3.14, Node 24,
Caddy 2.11, all by digest), installs the Python dependencies from
`backend/requirements.txt` at the versions pinned in
`backend/requirements.lock` (the same versions the desktop venv and the
PyInstaller build use, see [Python dependencies](DEVELOPMENT.md#python-dependencies)),
the central server's production dependencies from its own lock file
(`jacarium-central/package-lock.json`, installed in the Node build stage;
the Node binary itself comes from that stage), OpenSSH (for the workflow
SSH node) and Taskwarrior 2.6.2 (built from the checksummed source tarball:
EPEL 9 does not carry it), and runs as an unprivileged user. About 2.2 GB
on arm64 (the central server adds some 150 MB: Node and its modules).

**Three processes, one container.** `deploy/entrypoint.sh` (PID 1) starts
gunicorn (the backend, loopback), the central server (`node
/app/central/server.js`, loopback port 3000, its state under
`/data/central`) and Caddy, forwards TERM/INT to all three and waits. The
central server is supervised: a crash is restarted in place after 1 s
(doubling up to 30 s while it keeps failing, reset after a minute of
running) while the console stays up; Caddy or gunicorn exiting ends the
container, which the runtime's restart policy brings back. The
`HEALTHCHECK` asks `/health` **and** `/central/api/health`: the container
is unhealthy when either is down. The central server's lines carry a
`[central]` prefix in the container log. At idle the container uses about
110 MB (node 75 MB, gunicorn 100 MB over two processes, Caddy 45 MB; the
cgroup counts shared pages once). `JACARIUM_CENTRAL=off` runs the container
without the central server (no `/central` route, no team features);
`CENTRAL_UPSTREAM=host:port` forwards `/central` to a central server
running elsewhere instead (the 3.1 two-container shape, with
`JACARIUM_CENTRAL_TICKET_KEY` given in the environment).

**Keys.** On first start the entrypoint generates
`<DATA_DIR>/central/keys/yjs-encryption.key` (shared documents are
encrypted at rest with it - back it up; without it they are unreadable) and
`<DATA_DIR>/central/keys/account-ticket.key` (the key the backend signs
account tickets with and the central server verifies them with), both
0600; neither ever appears in a process argument. The client registry and
the encrypted Yjs snapshots live in `<DATA_DIR>/central/data`. One volume
backs everything.

Every stage of the Containerfile carries the label
`com.jacarium.image=deploy` (`com.jacarium.stage=ui|taskwarrior|app`),
and after each successful build `deploy/prune-images.sh` removes what the
build superseded - the previous image once the tag moved on, older stage
results - by that label only: nothing else on the machine, and never an
image a container (running or stopped) still uses. The newest untagged
result of the `ui` and `taskwarrior` stages is kept on purpose: it is that
stage's build cache (about 1.2 GB each), and with it an unchanged rebuild
takes seconds instead of recompiling Taskwarrior and rebuilding the UI.
`deploy/deploy-podman.sh clean` removes every image of the deployment
including those (the next build starts from the base images, a few
minutes) and keeps the `/data` volume. On macOS the Podman VM
needs about 4 GB of memory for the UI build (`podman machine set --memory
6144`).

### Sign-in and accounts

The server asks for a sign-in (`JACARIUM_AUTH_MODE=accounts`, the
default of `deploy/deploy-podman.sh` and `deploy/deploy-to-host.sh`).
**First run:** no account exists, so the backend prints a one-time *setup
code* in its log and writes it to `setup-code` on the data volume
(`deploy/deploy-podman.sh logs`, or `cat
~/.config/jacarium/server/data/setup-code` on the host). The
sign-in page asks for it once and creates the administrator; the file is
removed. Administrators add accounts in Settings > Users; everyone can
change their password and display name in Settings > General.

Every account has its own data: the browser keeps one database per account
(`Jacarium-<id>`), and on the server everything personal lives under
`/data/users/<id>/` - the settings file with the API keys, the Taskwarrior
data (`~/.task`, `~/.taskrc`: `~` is the account's home there), SSH
`known_hosts` and identities (`~/.ssh/id_*` - only an account's own keys
are ever offered), the RAG index, the Google Calendar token and a
`reports/` directory of its own. Administrators also keep *server
defaults* (Settings > Integrations / AI Providers, "server defaults")
that every account inherits until it sets its own - the place for a shared
API key. The shared `/data/reports` tree is readable by everyone
(Diagnostics: type its path as the directory); copy files there on the
host.

Sessions are an HttpOnly `__Host-` cookie (Secure, SameSite=Strict, 30 days
idle / 90 days absolute); every state-changing request must carry
`X-Requested-With: Jacarium` (the app does; `curl` users add it), and
Caddy still refuses cross-site requests. Sign-in attempts are rate limited.

**Administration (Settings > Users, administrators only):** create
accounts, reset a password, disable/enable, promote/demote (the role
button), delete an account (the username must be typed; its data
directory stays on the volume), and per account see its sessions and
linked desktop profiles and end/revoke them, download its server-side
backups and delete its data on the server. The last administrator can
neither be disabled, demoted nor deleted - the lockout of a forgotten
password is never recreated by a click. Everyone sees their own sessions
("Where you are signed in", sign out one or "everywhere else") and linked
devices in Settings > General > Account. **Settings > Audit** shows the
server's account log: sign-ins and failed attempts, password changes,
resets and recoveries, accounts created/disabled/promoted/deleted,
sessions and devices ended, and every data deletion
(`/data/accounts-audit.log`; never a secret).

**Delete all my data on the server** (Settings > General, with sign-in):
the opposite of Wipe Database, which resets only one device. It removes
the account's synchronised records from the server for every device:
each browser and linked desktop profile empties those records at its next
synchronisation instead of uploading them again - a device that was
offline too (its push with the old generation is refused and it
resynchronises from the empty store, after a local snapshot). A backup in
Export Database format is written under the account first
(`/data/users/<id>/backups/`, the last 3 kept; listed and downloadable in
the same section and, for administrators, under the user in Settings >
Users) and restores with Settings > General > Import Database. Required:
the account's password typed again and the username typed out; a linked
device's token cannot do it; three attempts per hour; every deletion is
in the audit log. The per-account files on the server (Taskwarrior data,
SSH keys and known_hosts, the settings file with the API keys, the
calendar token, the RAG index, the reports directory) are not touched
unless "Also delete my files on the server" is ticked - then they are
archived next to the backup (`<time>-files.tar.gz`) and removed; the
account and its backups stay. An administrator
can do the same for any account with their own password and the target's
username.

**Versions and the desktop app.** The server reports its version at
`/api/version` (`{app, protocol}`: the app version from `package.json`,
the compatibility protocol from `protocol.json` - the one source of truth
for both sides; no sign-in needed). A linked desktop app compares them
with its own when it links and before every synchronisation: the same
version says nothing; a different version with the same protocol shows a
small dismissible notice ("Desktop x.y.z, home server a.b.c") with a link
to the server's downloads; a different protocol *pauses* synchronisation -
nothing is merged or wiped - and a banner says which side to update; a
server from before this endpoint counts as an old server (notice). Both
versions show in Settings > General > Home server.

**Desktop app downloads from the server.** `https://<server>/api/downloads/`
lists the published installers with version, size and SHA-256 (links on the
sign-in page and in Settings > General > Database). The installers live on
the data volume (`/data/downloads/`, never in the image):

```bash
deploy/deploy-to-host.sh pi@192.168.0.50 publish-desktop --build      # builds macOS arm64 (dmg + zip) and copies what changed
deploy/deploy-to-host.sh pi@192.168.0.50 publish-desktop              # publishes the existing dist-electron/ output
deploy/deploy-to-host.sh pi@192.168.0.50 publish-desktop --build --linux   # also Linux AppImage arm64/x64 (without the packaged Python backend)
```

Only changed files travel; a normal deploy never touches them; the page
says so when nothing is published. The source code goes with them:
`jacarium-<version>-src.tar.gz`, a `git archive` of the release tag
(committed files only), listed under "Source code" with the Linux build
steps (`tar xzf ...; cd jacarium-<version>; ./rebuild.sh` - podman
or docker for the container build, or Node.js 20+, Python 3.14 and venv
with `--no-container`). The macOS build is unsigned: the page
explains the first-open steps (right-click > Open, or `xattr -dr
com.apple.quarantine`). Downloads need no sign-in (an installer is public
by nature; the service is on your LAN behind your proxy); names are
checked strictly, there is no directory listing.

**Forgot the admin password?** An administrator sets a new one in
Settings > Users; the only administrator, or anyone without one, recovers
from the server itself - whoever can run commands there owns it (there is
no e-mail):

```bash
deploy/deploy-to-host.sh pi@192.168.0.50 list-users              # usernames, roles, state - no secrets
deploy/deploy-to-host.sh pi@192.168.0.50 reset-password <username>
# local container: deploy/deploy-podman.sh reset-password <username>
# inside any container: cd /app/backend && python -m accounts reset-password <username>
```

It prints a one-time temporary password (never stored in clear), ends every
session of that user, re-enables the account if it was disabled and keeps
its linked desktop profiles (`--revoke-devices` revokes them;
`--make-admin` also makes the user an administrator). Sign in with the
temporary password: the app asks for a new one before anything else (the
server refuses every other request until then), and the temporary password
stops working. Each recovery is recorded in `accounts-audit.log` on the
data volume.

**Upgrading a server that ran without sign-in:** the next deploy switches
it to accounts (`--auth-mode none` / `AUTH_MODE=none` keeps the open
deployment). When the administrator account is created, the data the
container collected so far is adopted - copied, never moved: the settings
file becomes the server defaults, the Taskwarrior data, `known_hosts`, SSH
identities and the calendar token go to the administrator's own home
(`/data/migrated-to-accounts.json` records it). Each browser is offered
its pre-sign-in data at its first sign-in (it stays until deleted from
Settings > General).

For access from outside your network use a VPN (WireGuard, NetBird or
similar); never publish the port on the internet.

### Your data follows your account (synchronisation)

With sign-in, the browser's database synchronises with the server: every
device you sign in on converges on the same documents, boards, workflows,
tasks (the app's task rows), templates, categories, SSH commands, media
and the other tables (`src/utils/mergeCore.js` lists them). It works like
Import with merge, continuously:

- every record has one identity across devices (documents their
  `stableId`, kanban cards their `yjsId`, the rest a `syncId`), so a rename
  or a move never duplicates anything;
- the server orders all writes (a revision per record, a change sequence
  per account): a later edit replaces an earlier one, whatever the devices'
  clocks say; only two edits of the SAME revision - both made offline -
  are decided by the newer timestamp, and a clock that runs ahead is
  clamped on the server;
- deletions travel as tombstones, so a document deleted on one device
  disappears everywhere (an edit newer than the deletion brings it back);
- nothing is lost silently: when a newer edit from another device replaces
  yours, your version is kept as a "`<title> (conflict copy <time>)`"
  document on your device and as a version on the server
  (`/api/sync/versions`), and the Sync section of Settings > General says
  so; before a browser's existing data is first reconciled with the
  server, a snapshot in the Export Database format is kept there
  (download it from the same section; Import Database restores it);
- documents created on two devices before they were linked are paired by
  title + category (the newer content wins, like an import) instead of
  being duplicated;
- when you open a document, the latest changes are fetched first
  ("Updating from the server..."); the app also synchronises when the
  window regains focus or the browser comes back online, every 30 s while
  visible, and 1.5 s after your last change. The cloud icon in the
  bottom-right corner shows the state (click: sync now).

**Taskwarrior follows your account.** A task's identity is its Taskwarrior
uuid, and each device applies what arrives to its own Taskwarrior: a task
added, modified or completed on one device (the app's Tasks page works
CLI-first and re-reads `task export`) is imported into the Taskwarrior
instance of the same name on every other device - the Pi's for a browser,
the local one for a linked desktop profile (an instance that does not
exist there yet is initialised under `~/.task/<name>` first). A task purged
on one device is purged everywhere. The app's own data files are not
synchronised: this is the app keeping the instances aligned through the
CLI, so Taskwarrior on each side stays the source of truth it always was.

Wipe Database empties this browser only: the account's data is on the
server and returns at the next synchronisation. Not synchronised (yet):
the AI chat history, saved JQL queries and custom grids/quizzes (browser
storage).

### Without sign-in (`JACARIUM_AUTH_MODE=none`)

The earlier open deployment: **no authentication**. Anyone who can open
the published port can use the whole app and, through it, the SSH node,
Taskwarrior and the integration credentials stored in the container. The
deploy script then publishes it on `127.0.0.1` unless you set
`BIND_ADDRESS` to one address (it refuses `0.0.0.0` without
`ALLOW_ANY_ADDRESS=1`). Use it on your own machine, behind an SSH tunnel,
or on a trusted network only. Inside the container Flask listens on
loopback and Caddy is the only entry point; Caddy also refuses cross-site
requests, so a web page you visit elsewhere cannot drive the API with your
browser.

What the backend refuses even without a sign-in: there is no "run any
`task` command" route, a report filter may only contain filter terms (never
a word that `task` could read as a command, `execute` included), Taskwarrior
instances must live under `/data/.task` (`rcPath` inside it or `~/.taskrc`,
`dataPath` inside it; the taskrc lines the app writes are validated), a
Settings save cannot set a name that steers the process or its `task` /
`ssh` children (`TASKDATA`, `HTTPS_PROXY`, `SSL_CERT_FILE`, `LD_*`,
`PYTHON*`, `JACARIUM_*`, ...), and SSH connection reuse
(ControlMaster) is off, since one process serves every user of the proxy.

### What is stored where

Your documents, tasks, kanban boards, calendars and so on live in the
**browser's IndexedDB**, exactly as in the desktop app - per browser profile,
not on the server. Export/import them from Settings > General (Export /
Import Database) as usual. The `/data` volume (`DATA_DIR`, default
`~/.config/jacarium/server/data`) holds only what the server itself
needs:

| Path on the volume            | Contents                                                   |
|-------------------------------|------------------------------------------------------------|
| `accounts.sqlite`, `setup-code` | the accounts and sessions (sign-in); the one-time code of a fresh server |
| `users/<id>/`                 | one account's own files (its `.jacarium.env`, `.task/`, `.taskrc`, `.ssh/`, RAG index, calendar token, `reports/`) |
| `settings.env`                | the server-default settings every account inherits (administrators) - **secrets, keep private** |
| `.jacarium.env`        | without sign-in: Settings > Integrations / AI Providers (API keys, PAT...) - **secrets, keep private** |
| `reports/`                    | sosreports / must-gathers for Diagnostics (copy them here) |
| `certs/cert.pem`, `certs/key.pem` | TLS certificate (self-signed on first start)           |
| `.ssh/known_hosts`            | SSH host keys the workflow SSH node has accepted           |
| `.taskrc`, `.task/`           | Taskwarrior configuration and data                         |
| `.jacarium/vector_db/` | the RAG index                                              |

Back up the volume by copying the directory while the container is stopped
(`deploy/deploy-podman.sh stop`); the browser side is backed up with Export
Database. The settings file holds credentials in clear text - back it up
accordingly.

**Signed in to a home server, the identity is the account.** With accounts
(the browser deployment, or a desktop profile linked in Settings > General)
the Machine ID is `<username>@account-<id>`: the same in every browser and
linked desktop profile of the account, so what you share is owned by *you*,
not by one browser. The home server provides the central server itself
(below) and vouches for the account with a short-lived ticket (`POST
/api/auth/central-ticket`), so nothing is paired and nothing is stored on
the device: clearing a browser's site data and signing in again, a second
browser, or an unlinked and relinked desktop profile all come back as the
same identity, still owning their shared items, with the account's display
name (Settings > General > Account > Your name). The central server fans
one identity out to all of its connected devices.

**Switching accounts in one browser** is clean: signing out closes the
central-server socket, the reload drops every in-memory cache, and the
next account gets its own database, its own identity and its own
browser-local keys (the AI chat history, the Taskwarrior purge list,
custom grids and quizzes are per account - `key:<account id>`); presence
and chat show the new account, never the previous one. A desktop profile
belongs to one account: relinking it to another is refused (use Switch
Profile for a second account), so no data pours from one account into the
other.

Without an account the Machine ID shown in Settings > General is a local
identity only - `username@hostname` on the desktop, `browser-<8 random
hex>@<container hostname>` generated once per browser - and there are no
team features: the central server comes with the home server (below), and
items shared under such an identity by an earlier version keep naming it as
their owner until their owner signs in and shares them again.

### Diagnostics

There is no upload. Copy (or `scp`) each sosreport / must-gather directory
into `<DATA_DIR>/reports/` and press Refresh on the Diagnostics page: the
server only ever reads inside that directory (symlinks pointing out of it
are refused).

### Settings

Settings > Integrations and AI Providers work in the browser: the values are
written to the settings file on the volume and apply to the server right
away. Secrets are write-only - the server reports whether a key is stored,
never its value; leave a field blank to keep what is stored, type a new
value to replace it, or press Clear. The desktop app behaves the same way.

Settings opens from the Documents page's menu (the three lines next to the
page title) in the browser; the desktop app keeps its application menu
(Cmd/Ctrl+,).

### HTTPS

On first start the container writes a self-signed certificate to
`<DATA_DIR>/certs/` for `localhost` / `127.0.0.1` (add names with
`TLS_SAN="DNS:host,IP:1.2.3.4"`); the browser will ask you to accept it, or
import `cert.pem` as trusted. To use your own certificate, place `cert.pem`
and `key.pem` in that directory before starting (or set `TLS_CERT_FILE` /
`TLS_KEY_FILE` to mounted files).

### Team features: the central server comes with the home server

Shared documents, boards and workflows, presence, chat and the multiplayer
games go through the central server (`jacarium-central/`, Socket.IO +
Yjs), and that server **comes with the home server**: it runs inside the
console's container on loopback and the console's Caddy forwards
`/central/*` (prefix stripped) to it - one container, one address and one
certificate for the app and the team features, websockets included
(`https://pi.console/central`, the Socket.IO path `/central/socket.io`). A
proxy in front of the console (the Pi's own Caddy) needs no change:
everything is one origin.

**There is nothing to configure.** The app derives the URL (`<page
origin>/central` in a browser, from `GET /api/capabilities`; `<home server
URL>/central` on a linked desktop, from `GET /api/version`), and the central
server recognises a signed-in browser or a linked desktop through a ticket
the home server mints for its account (`POST /api/auth/central-ticket`:
HMAC-SHA256 over the account's identity `<username>@account-<id>`, ten
minutes, renewed before it runs out, never stored) with a key the two share
(`<DATA_DIR>/central/keys/account-ticket.key`, generated once on first
start, 0600). A ticket forged without the key is impossible and nothing has to be
reachable to check one. The ticket is the only way in: with the key set, the
central server pairs no devices (`POST /api/register` answers 403
`ACCOUNT_SIGN_IN_ONLY`). The identity teammates see is the account's - the
same in every browser and desktop profile of the account - with the
account's display name.

**Without an account there are no team features.** A signed-out browser
(or a `--auth-mode none` deployment) and a desktop profile that is not
linked to a home server have no central server: the pages say so calmly
("Link this profile to your home server (Settings > General > Home server)
to share documents with teammates" on the desktop, "Sign in to a home
server..." in a browser) instead of showing errors, and the games offer no
share links. Settings > General shows the read-only state of the team
features where the home server itself is described: in the **Home server**
section on the desktop (connected / connecting / version mismatch, the identity and the name teammates see), in the **Account**
section in a browser. The former Settings > Cloud Sync tab (a manual URL,
an enrollment secret, pairing, a certificate step) is gone, as is the
standalone central server: a deployment is the home server with its central
server behind it, and that is all the app knows.

The desktop reaches `/central` through the main process with the home
server's pinned certificate (no second pin); its renderer's WebSocket
handshake carries `Origin: file://`, which the console's cross-site guard
lets through for `/central/*` (no web page can send that origin) while a
foreign page's is refused.

For development the central server still runs on its own
(`jacarium-central/run.sh`, port 3000, no key: open pairing on loopback,
with a warning) - the Node tests drive it directly; the app itself talks to
it only through a home server.

Tests: `tests/central-account-ticket.test.mjs` (the ticket end to end
against the real console and central server: forged, expired, tampered and
mis-claimed tickets refused, the ownership rule, rate limits, the socket,
pairing closed on the deployed shape), `tests/account-central-identity.test.mjs`
(a browser against both servers behind a console-like proxy: no central
server without sign-in, the account identity, the derived URL, a shared
document, clearing site data, two accounts in one browser),
`tests/central-provided-url.test.mjs` (how the app derives the URL and the
reasons it shows when it has none), `tests/central-status-settings.test.mjs`
(the status in Settings > General and the hints) and
`tests/container-deploy.test.mjs` (the real containers: `/central` REST and
websockets through the console origin, the cross-site guard).

### Tests

`tests/container-deploy.test.mjs` builds the image, starts it with a
temporary volume and checks HTTPS, the app, settings with write-only
secrets, Diagnostics browsing (and traversal refusals), the Jira proxy
allowlist, the cross-site guard and the central server in
the container (`/central`, the keys on the volume, tickets, pairing closed,
the restart in place after a kill, `JACARIUM_CENTRAL=off`). It is part of
`tests/run-all.sh` and skips when no container engine is available.

## Deploying to another machine (e.g. Raspberry Pi)

`deploy/deploy-to-host.sh <user@host>` installs the browser Jacarium -
one container with the console and the central server - on another Linux
host over SSH and updates it in place with the same command. Nothing goes
through a registry: the image is built here (cached builds take seconds)
and sent over the SSH connection only when the host does not have that
exact image yet, as is the small target-side helper
(`deploy/remote-host.sh`). The target needs SSH
key authentication and either **rootless podman** (Raspberry Pi OS Bookworm
has 4.3, Fedora has 5.x) or **Docker** with the user in the `docker` group;
podman is preferred when both exist (`--engine docker` to choose). 64-bit
only (the image is UBI 9: no 32-bit builds). Apple Silicon builds arm64
images, which is what a Pi 4/5 runs; for an x86_64 target the script builds
with `--platform linux/amd64`, or on the target (`--build-on-target`).

```bash
# first install (the central server runs behind the console; nothing to configure on the devices)
deploy/deploy-to-host.sh pi@192.168.0.50
# later: the same command updates what changed and restarts only that
deploy/deploy-to-host.sh pi@192.168.0.50
deploy/deploy-to-host.sh pi@192.168.0.50 status
deploy/deploy-to-host.sh pi@192.168.0.50 logs               # the container's log ([central] lines included)
deploy/deploy-to-host.sh pi@192.168.0.50 uninstall          # keeps the state; --purge removes it
```

**The name.** Clients use one name for the host, `pi.console` by default
(`--name`): it is in the certificate and in every URL the script prints -
`https://pi.console:8443` (the app) and `https://pi.console:8443/central`
(the central server behind it; nothing to enter anywhere). The sockets bind
to the host's LAN address (detected, `--address` to set; never 0.0.0.0), so
the name has to resolve to that address on each client: the script checks
from the machine it runs on and prints the fix when it does not -
`echo "192.168.0.50 pi.console" | sudo tee -a /etc/hosts` on macOS / Linux,
or an entry in the router's local DNS. The IP URLs work without it. Extra
names (e.g. `raspberrypi.local`) go in with `--san`. Changing the name, the
address or the names later regenerates the certificates (the script says
so: browsers must accept them again, the desktop app re-pins).

**Behind a reverse proxy on the target.** If the host already runs a
reverse proxy with its own certificates (e.g. a host-networked Caddy with
`tls internal` serving `https://pi.console`, names resolved by Pi-hole),
deploy with `--public-url https://pi.console`: the console is then published
on the target's loopback only (`127.0.0.1:8443`; the proxy forwards to
`https://127.0.0.1:8443` and is the only way in) and the printed URLs are
`https://pi.console` for the app and `https://pi.console/central` for the
central server behind it - the proxy needs no change for it, it is one
origin. The console's own certificate stays self-signed (only the proxy sees
it, with verification off on loopback). The proxy must pass the Host header
through (Caddy does) so that Socket.IO's origin check sees the browser's
origin; WebSocket upgrades, the cross-site guard and long requests work
through the extra hop - verified against a Pi running exactly that.
`--no-public-url` returns to publishing on the LAN address.

Add `--proxy-ca-from caddy` (the proxy's container name; `--proxy-ca-path`
when its root is not at Caddy's `/data/caddy/pki/authorities/local/root.crt`)
so the desktop app can pin the proxy's certificate **authority** instead of
its short-lived certificate: on every run the helper reads the root out of
that container (`docker exec caddy cat ...` - read-only, the proxy and its
configuration are never changed) into the console's data dir
(`<data>/tls/root.crt`), and the console serves it at `/api/tls/root.crt`
(no sign-in: a certificate is public). The setting is stored with the
deployment; `--no-proxy-ca` stops refreshing it. Without it the console
behind a proxy serves no root (404) and the desktop falls back to pinning
the proxy's leaf certificate, which Caddy renews every 12 hours - the
script says so. Without a proxy the console's own self-signed certificate
is what it serves there.

**Docker targets.** With Docker on the target (the Pi above runs Docker,
not podman), the script uses it when podman is absent (`--engine docker`
to insist). The user must be in the `docker` group (the script prints
`sudo usermod -aG docker <user>` otherwise and never uses sudo); images
go over SSH as a docker-archive; containers run with
`--restart unless-stopped` as `--user <uid>:0` so the state dirs stay the
user's; superseded images are removed with
`docker image prune --filter label=com.jacarium.image=…`, never
unfiltered.

**What stays on the target.** The container's `/data`
(`~/.config/jacarium/server/data`: settings env file, certificate,
`reports/`, known_hosts, the accounts, and under `central/` the central
server's client registry, encrypted Yjs snapshots, Yjs encryption key and
account-ticket key) - the same place the single-machine script uses - plus
the deployment's settings in `~/.config/jacarium/deploy-to-host.conf`, so
a plain re-run reuses them. The container runs as the target user (podman:
`UserNS=keep-id`; Docker: `--user <uid>:0`), so you can edit the env file
and drop sosreports into `reports/` as that user.

**Updates and rollback.** Each run compares image ids and sends nothing when
the target already has the image; the container is restarted only when its
image or its definition changed. After a restart the script waits for the
container's own health check (the console and the central server behind
it); if it never becomes healthy the previous image (kept as `:previous`,
exactly one) is put back and the run reports the rollback. Older images of
this project are pruned by their label, nothing else.

**Reboots.** With podman the container is a systemd user unit (a Quadlet
`.container` file under `~/.config/containers/systemd` on podman 4.4+, a
plain `podman run --replace` unit under `~/.config/systemd/user` on older
podman such as Bookworm's 4.3), enabled in `default.target`; the user must
linger (`sudo loginctl enable-linger <user>` - the script prints it, or
`--enable-linger` runs it when sudo needs no password). With Docker the
container runs with `--restart unless-stopped` and the docker service
brings it back (`sudo systemctl enable docker` if it is not enabled; the
script checks). Note that Docker publishes ports with its own iptables
rules, which bypass ufw - the container binds to the one LAN address only.
Reboot check: `sudo reboot` the target, then `deploy/deploy-to-host.sh
<user@host> status` should show the container healthy.

**Upgrading a 3.0.x or 3.1 target (two containers) to the one container.**
The same `deploy/deploy-to-host.sh <user@host>` does it and says so first.
On the target the helper stops the `jacarium-central` container, **moves**
its state - `~/.config/jacarium/central/data` (client registry, encrypted
shared documents) and `~/.config/jacarium/central/keys` (the Yjs encryption
key and the account-ticket key) - into `~/.config/jacarium/server/data/central/`
(one rename each, nothing copied, nothing merged: a directory that exists
on both sides with content stops the run), rewrites the console's
definition without the shared network, starts the one container and waits
for its health check (console and central server). Only then are the old
container, its unit, the `jacarium` network and the `jacarium-central`
image removed; until then they are the rollback - if the new container does
not become healthy, the state is moved back, the console's previous
definition and image are restored and the central container is started
again, and the run reports it. Interrupted half-way, the next run resumes
(a directory already moved stays, one not moved yet is moved). Nothing on
the devices changes: shared documents, identities and accounts are the
same files, a signed-in browser and a linked desktop keep using
`/central` with their account. An enrollment secret stored by 3.0/3.1
(`central/keys/enrollment.secret`) has no reader any more - the central
server recognises signed-in users of the console by the account-ticket key
alone - so the deploy removes it once the container is up (and says so; a
later run finds nothing to do), and a device that was paired by hand without
an account has no team features any more - sign it in or link it. A 3.0.x desktop against a 3.1+ home server is told to update (protocol
2) and pauses synchronisation until it does. The old container's data
survives the upgrade in place, so there is no separate backup step; a copy
of `~/.config/jacarium/server/data/central/keys` somewhere safe is still a
good idea - shared documents are unreadable without the Yjs key.

`tests/deploy-to-host.test.mjs` (part of `tests/run-all.sh`) runs the script
against a throwaway podman target - the podman machine VM over its SSH port -
with its own instance name, port and state: a 3.1.0 two-container install
made with the scripts of tag v3.1.0 (an account shares a document there),
the upgrade to the one container with the central state moved and still in
use, an unchanged re-run that restarts nothing, an update with a changed
image that keeps the state, the certificate and the keys, a rollback from a
broken image (the migration's too), the unit surviving a simulated
restart, the central server restarted in place after a kill, and uninstall.
It skips when the VM is unavailable.
