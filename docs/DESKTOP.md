# The desktop app

Profiles, the Google Calendar integration and the connection indicator.

## Profiles (desktop)

The desktop app can keep several separate sets of data - documents, tasks,
boards, settings, API keys, SSH host keys, the RAG index, and the cloud
identity - in one installation. The **default** profile is what a
single-user installation always had (Electron's own data directory and
`~/.jacarium.env`); nothing moves. A **named** profile lives at
`~/.config/jacarium-<name>` with its own `backend/` home for the
Taskwarrior data, settings file and `known_hosts` (the real home's
settings file and `known_hosts` are copied in once on first use, never
moved), and its own home-server link, so two profiles on one machine can be
two accounts (or the same account twice).

Choosing: `jacarium --profile work` opens one (created if missing;
the old `INSTANCE_NAME=work` environment variable means the same, and
`./run.sh --profile work` passes it on in development). With one profile
the app opens it directly - there is no picker on a single-user desktop. With several, a small picker window opens first
(or the profile you ticked "always open"); File > Switch Profile... brings
it back. Settings > General shows the open profile. Two profiles can run
at the same time: each backend takes the next free port.

### Linking a desktop profile to your server

Settings > General > Home server (desktop app): enter the server's URL
(`https://pi.console`), your username and your password once. The main
process signs in, asks the server for a *device token* (its own
revocable secret, listed under your account's devices) and keeps it
encrypted with the OS keychain in the profile; the password is not stored.
From then on the profile's data synchronises with your account there
exactly as a signed-in browser's does (see "Your data follows your
account" below), through the main process with the token, and the team
features (the central server behind that home server) come with it.
"Unlink" revokes the token.

**The server's certificate.** A certificate the operating system trusts
(a public CA, or the server's local CA installed in the keychain) passes
as it is. Otherwise the desktop pins, when the profile is linked, the
**root of the server's own certificate authority** - fetched once from the
server (`GET /api/tls/root.crt`) over the connection that is trusted on
first use - and from then on verifies every presented chain against it
cryptographically (names, dates, every signature up to the root). A proxy
such as Caddy with `tls internal` renews its leaf certificate every 12
hours and its intermediate every week: both pass without a prompt, no
restart needed; a certificate from another authority is refused with the
warning that offers to trust it (then that authority's root is recorded).
A server that publishes no root (behind a proxy deployed without
`--proxy-ca-from`, see "Deploying") gets the 3.1 behaviour - the
certificate itself is pinned and a renewal asks again - and Settings >
General > Home server says so. A pin recorded by 3.0/3.1 (the certificate
itself) is upgraded to the root silently the first time the server still
presents that certificate; if it already renewed, the warning appears once
and "Trust new certificate" records the root.

**Trusting Caddy's root in a browser (and on a phone).** Browsers do not
pin; to stop them warning after every renewal, install the proxy's root
certificate once. Get it from the Caddy container on the server (`docker
exec caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt`,
or `caddy trust` on the machine that runs Caddy; the console also serves it
at `https://<server>/api/tls/root.crt` once the deploy copied it there).
macOS: double-click `caddy-root.crt` (Keychain Access imports it into the
login keychain, or drag it into System), open the certificate, expand
Trust and set "When using this certificate" to Always Trust. iPhone/iPad:
AirDrop or mail the file, open it, Settings > General > VPN & Device
Management > install the profile, then Settings > General > About >
Certificate Trust Settings > enable full trust for the root. The desktop
app then validates the server through the system too and records no pin. Linking is per profile, so two profiles can be two
accounts, or the same account twice.

## Google Calendar

The Calendars page shows your Google calendars and syncs their events into
the app. Google Calendar is optional: until it is set up and connected the
page shows a calm "Google Calendar isn't set up" / "Connect Google Calendar"
state, nothing is contacted, no sync runs in the background and no error
toast appears. Any cached calendars and events stay readable.

**1. Create the OAuth client (once, in Google Cloud).** In the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials)
pick (or create) a project, enable the **Google Calendar API** (APIs &
Services > Library), then under Credentials create an **OAuth client ID**
of the **Desktop app** type. If the consent screen asks for a user type,
External with your own Google account added as a test user is enough.
Copy the client ID (`...apps.googleusercontent.com`) and the client secret
(`GOCSPX-...`). The "Desktop app" type matters: the sign-in opens a browser
on the machine that runs the backend and receives Google's redirect on a
local port there (`http://localhost`), which only that client type allows.

**2. Paste them in Settings > Integrations > Google Calendar** (the "Open
Google Calendar settings" button on the Calendars page takes you to
Settings > Integrations). The desktop app stores them in `~/.jacarium.env`
(`GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`; the secret
is write-only - the dialog only shows whether one is stored). The page
re-reads the settings as soon as you save, no restart.

**3. Connect.** Press **Connect Google Calendar** on the Calendars page.
The backend starts the Google sign-in and the app says "Complete the
sign-in in your browser": a browser window opens on this machine, you pick
the Google account and grant calendar access, and the token is saved as
`~/.jacarium-gcal-token.pickle` (mode 0600). The page then lists your
calendars; Sync All and the five-minute auto-sync run from then on. If
the sign-in fails, the toast carries the backend's actual message (an
unconfigured client, a sign-in already in progress, a timeout after five
minutes). Disconnect with Revoke from the calendar's context menu, or
delete the token file.

**In a browser on the home server the sign-in is not available yet.**
The InstalledAppFlow above opens a browser on the backend's machine - in
the container, not on yours - so the Calendars page in the browser shows
"Connect Google Calendar from the desktop app" and the server refuses the
sign-in with a clear message (HTTP 501). Connecting there would need a
web OAuth flow: an OAuth client of the **Web application** type whose
registered redirect URI is `https://<your console>/api/calendar/oauth/
callback`, the server redirecting you to Google with a state value bound
to your session, and the token saved per account under the account's home.
The desktop app keeps the Desktop-app flow either way.

## Updates

The desktop app does not look for new versions by itself. Jacarium is
offline by default, so the check is a setting you turn on:
Settings > About > Updates > "Check for updates automatically". With it on,
the app asks GitHub once a day for the latest release
(`https://api.github.com/repos/jacarium/jacarium/releases`, a plain
unauthenticated request: nothing about you or the app is sent, GitHub sees
the request's IP address). "Check now" there, and Help > Check for
Updates..., make that one request when you click, whether the automatic
check is on or not. The request goes through Electron's networking, so the
system proxy applies; offline, or when GitHub cannot be reached, nothing
happens and the next check waits its turn.

When a newer release is out, a window shows what changed in every version
since yours (the release notes from the changelog) with a Download button
for your installation - the dmg on macOS; on Linux the AppImage when the
app runs as one, else the deb or rpm of your distribution - and "Skip this
version", which keeps that version quiet until the next one. The setting,
the last result and the skipped version are kept per profile
(`update-check.json` under the profile's data directory).

The app does not install updates itself: macOS needs a signed and notarized
app for that, and a deb or rpm belongs to the package manager. Download the
file, verify it if you like (the release carries `SHA256SUMS.txt` and a
build provenance: `gh attestation verify <file> --repo jacarium/jacarium`),
and install it over the old one; your data stays where it is.

## Connection indicator

The icon in the bottom-right corner of every window shows whether this
client is connected to its **home server** - nothing more, and there is no
setting behind it.

- **Online** (a green cloud): the account's data is synchronising with the
  home server - a desktop profile linked in Settings > General > Home
  server, or a browser signed in to the server. While a cycle runs the icon
  spins; a number next to it counts the changes waiting to be sent; a click
  synchronises now.
- **Offline** (a crossed-out cloud, amber): not connected, and the tooltip
  says why - "Not linked to a home server" (desktop), "Not connected to your
  home server" (a browser without a session), "Home server unreachable", no
  network, or a session / device token that has expired. Nothing is blocked
  while offline: changes are kept on this device and synchronise when the
  connection is back.
- **Update required** (red): the versions of the desktop app and the home
  server do not match, so synchronisation is paused (see "Home server").

The integrations - the team features through the central server, Jira,
Google Calendar, remote AI providers, workflow REST/SSH nodes, URL fetching
and WHOIS - simply work when they are configured. The app's own assets are
bundled (no CDN), so it also works without internet access.
