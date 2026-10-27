# Changelog

What changed in each release of Jacarium. The app shows the same notes
under What's New; `npm run release` adds each new version at the top
(see [docs/HOW_TO_RELEASE.md](docs/HOW_TO_RELEASE.md)).

## What's New in v3.4.8

_2026-10-27_

### [SECURITY]

Every release now carries the Sigstore attestation bundle of each file, as FILE.intoto.jsonl next to it: provenance, and for the installers the SBOM and VEX attestations, verified before they are attached. Anyone can verify a download offline: gh attestation verify FILE --bundle FILE.intoto.jsonl --repo jacarium/jacarium

The bundles are listed in SHA256SUMS.txt, and releases 3.4.5 to 3.4.7 got theirs attached too

## What's New in v3.4.7

_2026-10-27_

### [SECURITY]

Jacarium earned the OpenSSF Best Practices passing badge (project 15975), now shown in the README

The release workflow's shell steps pass actionlint's shellcheck checks

### [DEPLOY]

Development snapshots say clearly when the export was not confirmed

## What's New in v3.4.6

_2026-10-27_

### [DOCUMENTS]

The / command menu jumps back to the first entry as you type

### [SECURITY]

Release verification: the container images' per-architecture SBOM attestations are verified before a release is created (missing ones now stop the release)

The GitHub Actions workflows are checked with actionlint (pinned and checksum-verified) in the tests and in CI, so a workflow GitHub would refuse can no longer reach a release

Interim development snapshots: main is published to the public repository between releases as signed commits, for review (no tag, no installers); their messages pass the privacy scan

CONTRIBUTING.md: how to report bugs and propose changes, the coding standards and the test policy

### [TESTS]

Lint is clean and stays clean: npm run lint fails on any warning

## What's New in v3.4.5

_2026-10-27_

### [SECURITY]

Release pipeline fix: every installer gets its SBOM attestation (the x64 AppImage was missed in 3.4.4), and a check before the attestations fails the build if an installer is ever left out

Release runs are titled by their version in GitHub Actions

## What's New in v3.4.4

_2026-10-27_

### [SECURITY]

Release pipeline fix: the release workflow is accepted by GitHub again (3.4.3's was refused before it ran), so cosign signs in to Quay with the release's short-lived keyless robot token and the images get their cosign signatures and SBOM and VEX attestations in the registry

## What's New in v3.4.3

_2026-10-27_

### [SECURITY]

Release pipeline fix: cosign signs in to Quay with the release's short-lived keyless robot token, so the container images get their cosign signatures and their SBOM and VEX attestations in the registry (3.4.2's images were pushed and attested with GitHub, but cosign was refused)

## What's New in v3.4.2

_2026-10-27_

### [SECURITY]

Release pipeline fix: the container image's SBOM attestation carries a package-level copy of the SBOM (every package, licence and dependency; the file list left out), as the full document is over GitHub's 16 MB attestation limit. The full SPDX and CycloneDX SBOMs are still attached to the release

The weekly vulnerability rescan reads each image SBOM once, and the installers' SBOMs are checked against the attestation size limit when they are built

Versions follow Semantic Versioning from now on: patch releases for fixes and security updates, minor releases for new features

## What's New in v3.4.1

_2026-10-27_

### [SECURITY]

Release pipeline fix: the SBOM and VEX attestations name their exact files, so the release's provenance, SBOM and VEX attestations, the cosign-signed image and the draft release complete (v3.4.0 was tagged but stopped at that step)

Every image build names its target platform and checks the built image's architecture before it is deployed

Version numbers: the patch now runs 0-99 (3.4.9 -> 3.4.10), as releases are more frequent

## What's New in v3.4.0

_2026-10-27_

### [SECURITY]

First release published with the full supply-chain set: SLSA Build Level 3 provenance, SPDX and CycloneDX SBOMs, a cosign-signed container image, signed release commits and tags, a VEX statement, and a Grype gate that blocks images with fixable High or Critical findings (v3.3.8 and v3.3.9 were tagged but stopped by the new release checks before publishing)

Caddy in the container image is built from source with Go 1.27.2 and golang.org/x/net 0.60.0, fixing the Go advisories the upstream image still carries

The base image's unused Node.js and npm are removed from the container image

Release pipeline fixes: the installer builds honour the approved cooldown exceptions, verified tool downloads on macOS, VEX statements that match the scanned images

## What's New in v3.3.9

_2026-10-26_

### [SECURITY]

First release with the full supply-chain set (as planned for v3.3.8, whose release workflow failed before publishing): SLSA Build Level 3 provenance, SPDX and CycloneDX SBOMs, a cosign-signed container image, signed release commits and tags, a VEX statement, a Grype gate and continuous scanning, a reproducible container image

Fixed the release pipeline: the installer builds honour the approved cooldown exceptions, and the verified tool downloads hand back only the tool's path

Container image security updates: a newer Red Hat UBI 9 base (ca-certificates and OS fixes) and Pillow, brotli, certifi, filelock

### [DIAGNOSTICS]

Pod READY and STATUS as kubectl shows them, init containers shown apart; chips that never overflow and long lists that fold past 15; no overlapping text in tables

## What's New in v3.3.8

_2026-10-26_

### [SECURITY]

SLSA Build Level 3 provenance for the desktop installers and the container image: built by an isolated reusable workflow, verified by the release before publishing (gh attestation verify)

SBOMs in SPDX and CycloneDX for every installer and the image, attached to the release and attested

The container image is signed with Sigstore cosign (keyless, recorded in the Rekor transparency log)

Release commits and tags are signed and verified before they are pushed

A VEX statement (OpenVEX) with every release, saying which scanner findings affect Jacarium and why

Continuous scanning: OSV-Scanner on the lock files, a Grype gate on the image, a weekly rescan of the published SBOMs

Reproducible container image: 18 of 19 layers byte-identical between two builds, checked weekly

OpenSSF Scorecard, CodeQL code scanning and Dependabot (7-day cooldown); SECURITY.md with private reporting and response targets

Container image security updates: a newer Red Hat UBI 9 base (ca-certificates and OS fixes) and Pillow, brotli, certifi, filelock

### [DIAGNOSTICS]

Pod READY and STATUS as kubectl shows them: finished init containers no longer counted, failing init containers shown as Init:CrashLoopBackOff, an Init containers section on the detail

Chips never overflow: long labels wrap inside them, long lists show the first 15 with Show more

No overlapping text in tables and detail pages, including Field ownership paths

## What's New in v3.3.7

_2026-10-26_

### [DIAGNOSTICS]

Must-gather Log Viewer under Log Collection: every collected log (containers current and previous, host services, node journals, network), merged on one timeline, the same design as the sosreport viewer

Log Viewer: search, exclude, level and source filters run over all the selected logs on the server; per-container and per-service chart; a date-range picker that highlights the selected range; loading progress and Cancel

Open logs from a pod, a node, a Log Collection row or a crash finding goes straight to the Log Viewer with those logs loaded

Detail pages for pods, nodes, deployments and the other workloads: findings for the object, structured sections, recent changes from managedFields and a JSON viewer with search, folding and masked secrets

Tables fit the screen without a horizontal scrollbar: text wraps, numbers stay on one line, low-priority columns move into the expanded row

Clicking a chart bar filters by that exact bar on every chart

Journal logs in every journalctl format (incl. microseconds) show the real time, node and service

Pages with nothing to report show only their findings; Audit without audit logs and empty must-gather lists no longer show an empty card

Fixed: must-gather lists with an empty items field, Blame's expanded command rows and return codes, Export CSV downloading from Diagnostics

### [UI]

Links follow the theme, and every control keeps its rounded corners in every theme

### [SECURITY]

The privacy scan also catches IP addresses written as host names (ip-192-0-2-10)

## What's New in v3.3.6

_2026-10-24_

### [DIAGNOSTICS]

Every Diagnostics page opens with a Findings strip: problems first, worst first, with links to the related page; missing data is explained there and never reported as all clear

One design across every Diagnostics page: compact filter bars, rounded tables with sort markers, expandable rows, one pager, readable chips and meters coloured by the same thresholds as the findings

Charts stay inside their cards, show every label, size their bars to the number of categories and use the same colours as the badges; long gaps in time series show as a marked break

Audit for must-gather: search every API audit event by user, verb, resource, namespace, status, category and time, with request bodies and what changed when they were recorded

Processes, Services, PCI, Disk Usage, Scheduler Debug, C-States, SAR, Log Viewer, Pod Disruption Budget and Pods per node reworked for troubleshooting

Parser fixes for RHEL 7 to 9 and OCP 4 outputs: PCI, SAR (12-hour locales, RHEL 9 files), Scheduler Debug, LVM, free, ps threads, Pacemaker, HAProxy and cgroup v2

### [UI]

Buttons share one set of theme colours with readable contrast in every theme

### [SECURITY]

Updated body-parser, Electron, fast-uri, undici and zod for newly published advisories

The app's own HTTPS requests refuse certificates from the compromised eMudhra intermediates

## What's New in v3.3.5

_2026-10-23_

### [DIAGNOSTICS]

Log Collection pages for sosreport and must-gather: a size summary with the split by section or directory, the largest file, and one full-width table with a size bar on every row

Log files are sorted largest first, with Name and Size headers to re-sort, section chips and a search box

New must-gather Log Collection page (last in the sidebar): top-level directories, namespaces, container logs (namespace / pod / container), host service, audit and network logs by size

### [SECURITY]

Updated DOMPurify for a newly published critical advisory, and Electron for a moderate one

## What's New in v3.3.4

_2026-10-22_

### [DIAGNOSTICS]

Stack Traces, Hung Tasks and OOM Killer are redesigned: a summary with counts, a timeline and top modules or processes, identical events grouped (×N), and each event's details, stack and raw log lines one click away

Stack Traces now finds BUG, Oops, general protection faults, soft and hard lockups, RCU stalls and panics as well as warnings; the faulting frame is marked and unreliable frames are dimmed

Hung Tasks are grouped by where the tasks were blocked, with how long each was stuck

OOM Killer shows who was killed, how much memory it used, why (the whole machine or a cgroup limit) and the top memory users at that moment

The kernel tabs read the journal, dmesg and var/log/messages including rotated .gz files, on RHEL 7 to 10, without duplicates

Log Viewer now sits under Log Collection

New Sos Report > Blame: where the sos report's own collection time went, with charts of plugin run time, return codes and a timeline, and each plugin's commands

Charts keep working after switching between dark and light

### [AI]

AI Chat and Robin use the app's normal text size; headings in messages are only slightly larger

Robin formats your own messages the same way as the AI Chat sidebar

## What's New in v3.3.3

_2026-10-21_

### [AI]

Add as AI Context for a whole document or a workflow now sends its real content (it was empty in 3.3.2); a workflow is described step by step with its connections

The context sent to the AI no longer names the document, board or workflow, or its category

An empty or missing context is shown in red and never sent

### [UI]

Right-click AI Chat, Quick Notes or Team Chat in the compact sidebar to open it on the right; each panel reopens on the side you closed it on

Settings > Shortcuts: Open AI Chat, Open Quick Notes and Open Team Chat open the panel on its side

Team Chat's message box matches the AI Chat's

Export as JSON in Workflows, Kanban and Tasks opens a window where you can copy the JSON or download the file

Tasks: right-clicking a category opens its menu again (Export Category)

Phone: the sidebar drawers meet the bottom bar with no gap

## What's New in v3.3.2

_2026-10-21_

### [DOCUMENTS]

Ask AI About This (right-click a selection) opens Quick AI with the highlighted text included, and the answer goes on its own line below it

Add as AI Context for a selection: right-click highlighted text to start a new AI chat about just that text

### [AI]

Add as AI Context opens a new chat with your default model and sends the document's real content, clearly marked as a document

The context window has a Document tab with exactly what the AI receives (editable) and a Privacy tab: switch hiding per type or per value, never-hide and always-hide lists, or turn it off for one chat

Hidden values look like [REDACTED_HOST_1], and public names such as ghcr.io, quay.io or github.com are no longer hidden

AI Chat and Robin show headings, lists, horizontal rules, tables, callouts and code blocks properly

The bin clears the conversation when it is the only one, and removes it from the list when there are several

### [UI]

Import from JSON on Kanban, Tasks and Workflows uses the same window as Documents: paste or upload, Dry Run, and merge newer copies into what you already have

Right-click the bell in the compact sidebar to clear all notifications

Selecting an item in a sidebar no longer makes its text shift

The mouse wheel scrolls the tab bar sideways when the tabs don't fit

### [SECURITY]

Updated vite and follow-redirects for newly published high-severity advisories

## What's New in v3.3.1

_2026-10-20_

### [SETTINGS]

Settings > Shortcuts: every keyboard shortcut is listed and can be changed, removed or reset, per device; the desktop menu follows at once

The shortcut recorder warns before you pick keys another action already uses, keys your system or browser takes first are refused, and Linux habits such as Ctrl+Shift+C get a warning

Copy this device's settings to your account opens as its own window on top of Settings, and lists each setting by its name in Settings

### [UI]

No more shortcuts that switch pages by accident (Ctrl+Shift+C opened Calendars); assign your own in Settings > Shortcuts if you want them

Bold, Insert link and Replace have no shortcut by default; Find (Ctrl/⌘+F), Find in Files (Ctrl/⌘+Shift+F) and the command palette (Ctrl/⌘+K) stay

Tabs in the Media Library, the import dialog and under Robin's replies have the app's straight underline

## What's New in v3.3.0

_2026-10-20_

### [DESKTOP]

Fedora and RHEL: install and update Jacarium with dnf - sudo dnf copr enable robincernin/jacarium, then sudo dnf install jacarium (Fedora 42 and newer, RHEL 10 with EPEL)

The packages are the official release builds, checked against the release's SHA256SUMS.txt, and are built automatically when a release is published

## What's New in v3.2.9

_2026-10-20_

### [SETTINGS]

Settings used by this device: choose This device or My account at the top of Integrations and AI Providers once the desktop is linked to your home server

My account: the desktop uses your account's settings from the server, the same ones your phone uses, keys included; keys stay in your system keychain and are never shown

Everyone shows the server-wide defaults: read-only, or editable by an administrator after confirming the password

Each field says where its value comes from (your account, everyone or not set), and a change made on another device is never overwritten silently

Copy this device's settings to your account: a one-time offer, also under General > Home server

Unlinking the device or signing out removes your account's keys from this device

## What's New in v3.2.8

_2026-10-19_

### [AI]

Quick AI (/ai), Ask AI, the AI panels in Quick Notes and the quiz and grid generators use your Default AI Provider and Model from Settings, on the desktop and the web

With no AI provider set up, they say so ("No AI provider configured - set one in Settings > AI") instead of showing a backend error

## What's New in v3.2.7

_2026-10-19_

### [DOCUMENTS]

A tidier editor toolbar: Bold, Italic, Strikethrough and Code; one Heading menu that shows the current level; one List menu (bullets, numbers, task list) with indent and outdent; Link; and one Insert menu

Insert menu: table, image, table of contents, the five callouts, quote, horizontal rule, code block, and a PDF section with page break, blank page, centered page, page header and page footer

Type / for the same blocks: /hr, /quote, /toc, /code, /pagebreak, /blankpage, /centerpage, /header and /footer

Shortcut hints match your system (⌘B, ⌘I, ⌘K on a Mac, Ctrl elsewhere); Tab and Shift+Tab indent and outdent inside lists

On a phone the toolbar fits on one row, with the rest under ⋯, and its menus open above the editor

### [TASKS]

The done checkbox is back on every task card: click the circle to mark a task done, click again to undo

### [CALENDAR]

Sync active calendar moved from the sidebar header into the ☰ menu

### [AI]

Claude chats work again, with an API key and with Vertex AI (the newer Anthropic library no longer accepts a temperature)

OpenAI chats work again

Robin with a thinking model (qwen3, deepseek-r1) has room to answer, and a follow-up question is answered instead of the first one again

Robin searches the current text of your notes, and rebuilds its index when the search model changes

Robin no longer says a local model is external, and a new chat starts from your Default AI Provider and Model

Settings: the temperature hint says what it applies to; Claude uses its own default

The re-check button on the "backend offline" banners shows again

## What's New in v3.2.6

_2026-10-19_

### [DOCUMENTS]

Callouts: write > [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION] to get a coloured block with an icon, the same syntax as GitHub

Callouts take an optional title (> [!WARNING] Before you deploy) and can be folded with > [!TIP]- (closed) or > [!TIP]+ (open)

Callouts print as coloured blocks in PDF export, folded ones printed open, and show on the phone too

Insert callout in the editor toolbar, or type /note, /tip, /important, /warning or /caution

The "/" popup lists the built-in commands (callouts, Quick Workflow, Quick AI, Quick Task) above your templates, and nothing runs until you press Enter; paths like /usr/local/note stay plain text

Tab bar on a narrow window: the "N open" list has square corners and opens above the sidebar

## What's New in v3.2.5

_2026-10-19_

### [SYNC]

A document opened on another device no longer shows up as two tabs, and closing it closes just that tab

Tabs that were already doubled are merged into one when the app opens

### [DIAGNOSTICS]

Log Viewer: the (?) button is gone; the Search logs and Filter out tooltips explain the search syntax

## What's New in v3.2.4

_2026-10-19_

### [DIAGNOSTICS]

Log Viewer: the date range slider shows its line again, with the chosen range highlighted

Log Viewer: the file picker, Get Date Range, Load Logs and Export CSV sit on one tidy toolbar, with Search logs and Filter out on the row below

Log Viewer: filters keep applying after Load Logs or a new date range, and the counts and Export CSV follow them

Log Viewer: searches with an apostrophe (can't) or a backslash (C:\temp) now match, and typing stays quick on long logs

Log Viewer: you can switch between levels directly, and the process list follows the chosen level

Log Viewer: a date range no longer drops its first entry

Log Viewer: levels are read the same way for every log file; a word like "preferred" no longer counts as an error, and a line that states no level shows as Other

## What's New in v3.2.3

_2026-10-18_

### [WORKFLOWS]

Phone layout: a Transform shows its whole code, wrapped to fit, and an untouched one shows its default code

Phone layout: a step's inputs are listed under Inputs, naming the input and the step it comes from (for example left ← REST API); tap one to jump to that step

Phone layout: the steps of a workflow are evenly spaced

### [SYNC]

A tab opened on another device now shows its content straight away, even when it arrives before the document itself

## What's New in v3.2.2

_2026-10-18_

### [WORKFLOWS]

Phone layout: a running workflow shows each step live (running, done or failed, with the error), follows the step that is running, and has a Clear button next to Stop

Phone layout: workflow steps show their content in full: the method and whole URL of a REST API call, several lines of a Transform's code (tap for the rest), SSH commands and variable names

### [SYNC]

Open tabs follow you: the documents, boards, task lists, calendars and tools you have open appear on your other devices signed in to the same self-hosted server, and closing a tab closes it there too. Only names travel, never content; the tab you're looking at is never switched under you

### [SETTINGS]

Application Settings > General: "Sync open tabs across devices", on by default (greyed out until this device syncs with a server)

### [UI]

Phone layout: the Tools page has the "N open" menu to switch between and close open tools, like Documents

### [DEPLOY]

Deploying to a home server starts the Podman machine on a Mac when it isn't running and builds there, instead of falling back to a slow build on the server


## What's New in v3.2.1

_2026-10-17_

### [TASKS]

Task cards are easier to read in the light theme: every label and button has stronger contrast, and completed tasks are no longer faded

Taskwarrior: a task that hasn't changed is no longer re-saved and sent round your other devices

Taskwarrior: the safety backup taken before the first sync is saved again

### [AI]

Robin: a fresh profile starts with one chat instead of two

### [UI]

New: a phone layout. Open a self-hosted Jacarium in your phone's browser and it switches to a layout made for phones, with a bottom bar, drawers for the sidebars and a menu button on every list item. In the light theme the top and bottom bars stay dark

Phone layout: workflows are view-only; edit them on the desktop


## What's New in v3.2.0

_2026-10-16_

### [AI]

Settings: on/off options are toggles (debug status bar; Bedrock and Vertex AI)

### [SYNC]

Tests leave no orphans behind; the desktop engine refuses to sync with its local backend

### [SECURITY]

README and SECURITY.md: the optional, off-by-default update check is the only request the app makes on its own

### [UI]

Toggle: anchor the knob to the track's left edge

### [DESKTOP]

Tell people when a newer Jacarium is out (opt-in release check)

Linux: the app icon for every window, on X11 and Wayland

### [DEPLOY]

rebuild.sh: container builds keep their node_modules and venv in named volumes

### [TESTS]

Linux .rpm without /usr/lib/.build-id links: no file conflict with other Electron apps

### [MISC]

publish-release.sh: resuming is explicit (--resume); re-review fixes

publish-release.sh: fixes from review - resume, branch and remote checks, notes review

scripts/publish-release.sh: release to GitHub in one command

Docs: the optional update check, and updating a self-hosted server


## What's New in v3.1.9

_2026-10-15_

### [DOCUMENTS]

Central server enforces Read & Write on shared documents and boards

Board and document permissions: shared items are visible to the whole team, read-only without Read & Write

### [KANBAN]

Remove the empty "Check for shared updates" buttons (Documents, Kanban, Tasks)

### [TEAM]

Self-hosting: how to share the container on your network (LAN address, certificate, firewall), and a README pointer

Drop the client's dead HTTP polling of the central server

"Sync Changes" works for Read & Write members

Team sharing says "Share with the Team" everywhere (text only)

### [DESKTOP]

README: .rpm downloads for Linux (Fedora, RHEL), and the minimum distributions

README: download the desktop app from GitHub Releases (which file, macOS Open Anyway, Linux, verifying)

package-lock: the root funding entry where npm writes it

### [DEPLOY]

Self-hosting from the published image: quick start in the README and docs

Containerfile: node and caddy pinned to their multi-platform digests

rebuild.sh: a python3.14 on the PATH first (actions/setup-python on CI; Homebrew's here)

rebuild.sh: electron-builder --publish never (it only builds; the release workflow publishes)

### [MISC]

GTFOBins tool: credit to gtfobins.org

export-source.sh: export the dot-files a build needs (.gitignore, .nvmrc, .npmrc, container ignore files)

README: no Intel Mac download (lancedb and pylance ship Apple silicon wheels only)


## What's New in v3.1.8

_2026-10-15_

### [DOCUMENTS]

README: the split view next to the Documents screenshot

### [DIAGNOSTICS]

README: no Diagnostics screenshot, no log viewer mention

### [SECURITY]

SECURITY.md: private vulnerability reports, supported versions, how Jacarium is kept secure

### [UI]

README: a phone gets the web app in its browser, not a mobile-optimised app

Support Jacarium: GitHub Sponsors next to Ko-fi (About, desktop About)

### [DESKTOP]

package-lock: the root package's funding field, as npm writes it

### [TESTS]

The previous app name is gone from everything users read: Jacarium everywhere

### [MISC]

CHANGELOG.md renders to the end: "&lt;" is written as &lt;

Review fixes: the screenshot allowance checks WebP bytes; README claims match the app

README is the project's pitch; release notes move to CHANGELOG.md, guides to docs/

export-source.sh: fixes from review

scripts/export-source.sh: mirror a committed version into a publishing checkout


## What's New in v3.1.7

_2026-10-15_

### [TEAM]

Licence: AGPL-3.0 (was MIT)

### [SETTINGS]

About: report-an-issue link, the licence links to its text, credits for the fonts and React Flow

### [UI]

Support Jacarium: tip on Ko-fi (About, desktop About, README, FUNDING.yml)

About: source code link (github.com/jacarium/jacarium) and the author's GitHub

### [MISC]

Drop .github/FUNDING.yml while the repository is private

Screenshot workflow: five clear columns, wires without loops, the minimap corner kept free


## What's New in v3.1.6

_2026-10-15_

### [DOCUMENTS]

QuickWorkflow: reuse FloatingSSHTerminal for the interactive SSH window

### [WORKFLOWS]

Workflows: cloud wording back for sharing actions

Command palette: a proper search field, and arrow keys that scroll the list

Workflows: "Export Workflow (JSON)" in the context menus

Workflows: wiring feedback, snap to grid, align / distribute, auto-tidy, shortcuts help

Workflows: node search in the library and a quick-add palette

Workflow canvas: Figma/Blueprints-style navigation

Workflow canvas: pins on the node border, wires that end at them, themed chrome

Workflows: undo and redo on the canvas

Workflows: retire the CloudSync-era leftovers, keep team sharing

InteractiveSSHTerminal: split the session, tab completion and command sidebar

WorkflowList: split the menus and rows out, dedupe the cloud actions

WorkflowBuilder: move the canvas interactions into useWorkflowCanvas

WorkflowBuilder: move the library actions into useWorkflowLibraryActions

WorkflowBuilder: move the editor session into useWorkflowSession

WorkflowBuilder: extract the Base64 modal, bulk-move modal and tab menu

Workflow nodes: shared field editors, hooks and body blocks

Remove unused workflow code

Workflow engine: one execution context, input resolution split from node logic

### [CALENDAR]

Settings text no longer points users at the README

### [UI]

Context menus: every Delete item is red, icon included

Context menus: icons for every action

Node library filter: magnifier and clear button inside the field

Connection notices once for the app: no Offline/Online pair at start, none lost on a page switch

### [TESTS]

Workflow engine: pin the current execution semantics with tests


## What's New in v3.1.5

_2026-10-14_

### [MISC]

Screenshot tool: neutral theme, split-view shot, free backend port

Screenshot tool with synthetic content for the website


## What's New in v3.1.4

_2026-10-14_

### [DIAGNOSTICS]

Diagnostics card radius is the token without !important

Diagnostics tab frames follow the app theme

### [SYNC]

Sync safety snapshots: once per replica, three kept, labelled

One connection indicator for the home server

### [SETTINGS]

Settings opens on the integration the page asked for

Backend integrations work whenever they are configured

### [UI]

What's New is one list per major line, grouped by category

### [TESTS]

Orphaned-banner test counts only the cleanup's backend calls


## What's New in v3.1.3

_2026-10-14_

### [CALENDAR]

Google Calendar is optional

### [SETTINGS]

Offline Mode wording matches what it blocks

### [TESTS]

scripts test finds the end of the README history by its heading


## What's New in v3.1.2

_2026-10-14_

### [TEAM]

Connection-status callbacks read the { connected } they are given

Central server names itself "Jacarium central server"

Game share pages work behind the console's /central prefix

### [SECURITY]

Sign-in page without the icon and the password-recovery hint

### [UI]

Tab strips are square, like the sidebar list rows

### [DEPLOY]

Deploy removes the unused enrollment secret of 3.0/3.1

### [TESTS]

Taskwarrior follow test compares import stamps as a window

What's New live test measures scrolling with a synthetic long entry


## What's New in v3.1.1

_2026-10-14_

### [TEAM]

Central server through the home server only, Cloud Sync settings removed

### [SECURITY]

Root certificate endpoint answers without a sign-in

Desktop pins the home server's CA root, not its renewing certificate

### [DEPLOY]

One container: the central server runs inside the console image


## What's New in v3.1.0

_2026-10-14_

### [DOCUMENTS]

Documents: sync notices in the editor's notice strip

### [DIAGNOSTICS]

Diagnostics: Security overview, DPDK guard and parser fixes

### [TEAM]

Central server behind the console at /central, account tickets instead of pairing

### [TESTS]

Brand pages test: read the sync protocol from protocol.json


## What's New in v3.0.3

_2026-10-13_

### [DOCUMENTS]

Documents open local first; the server's changes arrive in the background

### [TASKS]

Rewrite only another machine's Taskwarrior paths at import; test and README follow-ups

Taskwarrior follows imports and the first pull, with this device's paths

### [WORKFLOWS]

Workflows rows use the shared list row

### [JIRA]

Jira is optional

### [SETTINGS]

The old-database offer only where an old database exists

Administer the home server from the desktop app

### [UI]

Sidebar lists: square full-width rows everywhere

### [DEPLOY]

Browser deployment: static files by existence, the entry and hashed assets explicit

Browser deployment: the built files are public, with a real favicon.ico

rebuild.sh: the mac default is the dmg

rebuild.sh: default package format per platform

### [TESTS]

generate.py: --copy-to no longer deletes its own copies

Mock sosreport and must-gather for trying the Diagnostics page


## What's New in v3.0.2

_2026-10-13_

### [DOCUMENTS]

Documents context menu: the Preview item is text only

Keep the Documents tab strip working where CSS.escape is missing

Make the Documents tabs usable on a phone

### [JIRA]

Jira proxy: refuse a bad path before checking the configuration

Make the Jira site a setting (JIRA_URL) with no built-in default

### [TEAM]

Rename the central server folder to jacarium-central

### [SECURITY]

Privacy scan: keep its own comment out of the user@IP check

Add a privacy scan for the source archive; strip icon metadata

### [UI]

The mark follows the gradient colour schemes

Sidebar mark opens Settings

Menu items and fields: the shared look everywhere

Text buttons and menus: text only

Jacaranda dark theme

Empty states, headings and the last decorative icons

Neutral colours from the theme tokens

Buttons and form controls: one radius, normal weight, no icons in text buttons

UI primitives and design tokens

Sora as the app font

Rounded corners across the app

Brand pages: sign-in hero, About, What's New and downloads headers, sidebar mark

Jacarium icon and brand sources

Neutral placeholders, prompts and examples

Make What's New text only

### [DESKTOP]

Packaged-app launches are isolated or refused

### [DEPLOY]

One entry point per task for the shell scripts

### [TESTS]

Code highlight test: the dark code block background comes from the token

Import fixtures from the previous name

### [MISC]

Rename the internal identifiers and paths

Rename the app to Jacarium

Neutral wording in comments, tests and examples

Add the MIT license; keep the desktop metadata's version in step


## What's New in v3.0.1

_2026-10-12_

### [SYNC]

Upload what a linked profile already had; package protocol.json; the home server ignores Offline Mode

### [DEPLOY]

Publish the source code next to the desktop installers

publish-desktop --build starts from a clean dist-electron

### [TESTS]

Fix the npm audit finding in http-cache-semantics (GHSA-ch52-4w7c-c8xp)


## What's New in v3.0.0

_2026-10-12_

### [DOCUMENTS]

Cloud Sync is a Settings tab; the Documents menu loses its Cloud Settings entry

Share the merge rules between import and sync; keep each account's records on the server

Use the backend's browser-mode services and move Settings to the Documents menu

Offer page size and orientation for the Documents PDF export

Remove the jsPDF/html2canvas PDF exporter; the desktop app prints PDFs

Export Documents to PDF with Chromium's print engine under Electron

### [TASKS]

Check the Taskwarrior version without rc overrides; count only image inputs; adapt the bundle guard

Close the Taskwarrior command-execution holes and confine instance paths

Say "backend not reachable" on the Tasks page instead of blaming Taskwarrior

### [WORKFLOWS]

Run the central server on Node 24 with a working health check

### [AI]

Turn SSH connection reuse off behind the proxy; load the configured settings file in the AI models route

Send system prompts to Gemini as a system instruction

Move Gemini chat from the deprecated google-generativeai SDK to google-genai

### [DIAGNOSTICS]

Keep the desktop's Diagnostics directory string as the user typed it

### [TEAM]

Send the session cookie with every backend request

The cloud identity is the account: one identity on every device, paired once

Cloud settings: explain how to pair a browser and say why a connection test failed

Deploy the central server for browser users: SAN certificates, image cleanup, health, clear CORS setup

Let the browser app's origin through the central server's CORS without locking out the desktop

Show the chosen display name in the games and on the Kanban board too

Give each browser its own cloud-sync identity instead of unknown@unknown

Apply the 7-day min-release-age rule to central-p2p-server

Fix central-p2p-server npm audit findings

### [SYNC]

Desktop-to-server version check, and the desktop installers served by the server

Admin hardening, sessions, an audit log, and "Delete all my data on the server"

Switch accounts cleanly in one browser or one desktop profile

Taskwarrior follows the account: tasks reach every device's own Taskwarrior

Link a desktop profile to the home server with a device token

Synchronise the app's database with the home server

### [SECURITY]

One look for the Settings dialog, with Users, Audit and the data deletion

Recover a forgotten password from the server: reset-password and list-users

Adopt a container's pre-accounts data when the first administrator is created

Keep every account's files apart on the server

Add sign-in with accounts to the browser deployment

Describe what the browser deployment refuses without a sign-in

Bump source-map-js and override global-agent to fix npm audit findings

Override katex and postcss-selector-parser to fix npm audit findings

Bump proxy-addr and joi to fix npm audit findings

### [SETTINGS]

Sign in from the app: setup and sign-in pages, one database per account

Refuse process-steering names in Settings saves

Make the app degrade cleanly in a plain browser

### [UI]

Drop the Tailwind v3 sRGB palette shim; use Tailwind 4's oklch palette

Migrate the build from Tailwind CSS 3.4 to 4.3

Point both Tailwind stylesheets at their config with @config

Pick What's New versions from a dropdown, one at a time

### [DESKTOP]

Desktop profiles: several sets of data in one installation, with a picker

Keep the Settings dialog's secrets out of the desktop renderer

### [DEPLOY]

Survive a redeploy in an open browser: cache headers, assets kept, reload once

Tell the target which components are unchanged, so it never restarts them for a retagged image

Deploy with sign-in by default; leave a component alone when its inputs did not change

Deploy the browser console and the central server to another host over SSH

Build the deployment image in docker format so the HEALTHCHECK works

Refuse to start the deployment when its image is not built

Remove the container images a build supersedes, by this project's label only

Run the backend on Python 3.14 locally and in the container

Fix the backend's vulnerable Python packages and lock one set of versions for venv and container

Package the app for a browser: one UBI 9 container with Caddy and gunicorn

### [TESTS]

Test two browsers syncing through a real central server container

Test the Electron PDF export against the browser exporter

Dismiss What's New and emulate focus in the visual snapshot driver

Add real-app visual snapshot driver and Tailwind regression test

### [MISC]

Remove the backend's unused machine ID endpoint

Remove the unused Flatpak manifest and its build script

Add the backend routes the app needs when it runs in a browser

Rewrite Tailwind class names for v4 across the app and legacy templates

Bump shell-quote to 1.11.0 for GHSA-pqg4-j6r4-53mv


## What's New in v2.6.0

_2026-10-03_

### [DOCUMENTS]

Make the Find in Files selection visible and drop its focus outline

Restyle Find in Files and scope it with a category dropdown

Show the whole document in a resizable Find in Files preview

Replace Documents sidebar search with a Find in Files window

Rework Documents import/export with dry run, merge modes and images

Keep double spaces in the Documents editor on macOS

Export/import tasks as per-instance TaskWarrior JSON

Add "Create Document In" to the Tasks right-click menu

Add /task command with Quick Tasks window in Documents editor

Highlight python/go/bash/yaml/json code blocks in Documents preview

Make export/import terminal panes follow light and dark themes

Fix merge DB import and add Dry Run with import statistics

Bake arrowhead markers into SVG export so Illustrator keeps edge lines

Inline computed styles in SVG export so edges survive CSS-less viewers

Add Download SVG context menu on Mermaid diagrams; stop needless redraws

Ensure readable Mermaid labels in dark mode

Recalibrate editor gutter when the textarea remounts after preview

Fix trailing blank page in Documents PDF export

Add Mermaid diagram support to Documents preview and PDF export

Fix duplicated document categories and self-heal existing duplicates

Use overlay scrollbars on Linux to remove sidebar right-edge gap

Render GTFOBins comments as sanitized Markdown

Add GTFOBins reference tool under a new Security category

Fix uneven word spacing in Documents PDF export

Fix sub-pixel gutter/cursor misalignment in the Documents Page editor

Fix Documents Page gutter line numbers drifting out of sync

Add progress modal to database, document, and category exports

PDF export: header/footer directives, page numbers, and ToC/text fixes

Add Table of Contents insert button and clickable PDF links

Add Export PDF to the single-document context menu

Add heading ids to document preview so ToC anchor links work

Add Export Document (ZIP) to the single-document context menu

Fix dark theme on locked-documents bulk delete modal

Add global preview-all-documents state to the preview toggle

Fix Ctrl+F highlight misalignment caused by line-height rounding

Fix middle-click tab close pasting clipboard text into editor

Move offline document banner below the toolbar

Add middle-click to close document tabs

Fix two more unclamped context menus found in a codebase-wide audit

Match merge-imported documents by a stable UUID, not title+category

Add opt-in merge mode to database import

Repair broken syntax in orphaned FloatingDraft and AskAIPopup

Replace remaining native dialogs in documents, AI chat and kanban

Migrate locked-document delete to shared typed-confirmation modal

Switch DocumentsPage list state to metadata-only documents

Stop the 3s fallback from duplicating text documents on slow sync

Fix missing truncation on sidebar category headers when sidebar is narrow

Make the sticky search band transparent so only the pill occludes

Redesign document search as a sticky pill inside the scroll container

Move read-only banners below the toolbar in DocumentEditor

Targeted peer-update handling and Yjs-aware autosave in document sync

Signal unloadable Yjs snapshots to clients; show local copy read-only instead of silently reseeding

Fix collaborative cursor rendering: flicker under concurrent typing and invisibility in wrapped documents

Persist Yjs documents to disk with AES-256-GCM encryption at rest

Gate Yjs debug logging, scope broadcasts to document rooms, evict idle docs

Remove unused DocumentsPage.backup.jsx

Preserve cloudDocumentId on received cloud documents so live Yjs sync engages

Fix cloud-doc editor: engage live Yjs sync on upload and keep gutter line numbers live

Remove per-keystroke overhead from the document editor typing path

### [TASKS]

Break down TaskWarrior export log by task status

Show and clean orphaned cached tasks on the Tasks page

Close .env injection, log leaks, token perms and task argv gaps (L1-L8)

Replace native confirm() in task pages and query/template sidebars

Replace native dialogs in TaskWarrior instance management

Open TaskWarrior download link in the external browser

Fix silent no-op when deleting a task via /api/taskwarrior/update

Fix purge-deleted using the wrong TaskWarrior verb; add tests for both fixes

Add timeouts to custom AI requests and batch TaskWarrior purge

### [KANBAN]

Auto-save and resume Sentence Builder board state

Dim Sentence Builder bank words once placed on the board

Fix silent data loss on shared Kanban boards (id collision + resurrection)

Deduplicate UUID v4 generator into shared util; add DEBUG_LOGGING gate for noisy logs

### [WORKFLOWS]

Replace node-forge in the CSR generator with WebCrypto and pkijs

Stop marquee node selection from also text-selecting node content

Fix node palette scroll overshoot and persist category collapse state

Fix parallel execution live-updates, add node layer ordering and edge direction arrows

Refactor Workflow Page graph UX, fix node-drag vs text-select bug

Block forged sync ownership and sandbox workflow transform code

Pin .nvmrc to exact Node 24.18.0

Restore Fast Refresh eligibility for component files

Replace native dialogs in workflow components

### [CALENDAR]

Add middle-click tab close to Calendar and Tools pages

### [JIRA]

Open JIRA token settings link in the external browser

Lazy-load page components to split the renderer bundle

### [AI]

Fix RAG retrieval quality and dataset chat streaming bugs

Prevent shell injection in SSH AI chat via base64 message transport

Port the Documents-sidebar sticky-pill search to AI Chat conversations

Remove SSH chat debug timing logs added for the pool hang diagnosis

Fix indefinite hang when SSH AI command template is saved blank

Add timing/progress debug logs to AI Chat SSH pipeline

Fix AI-chat SSH read timeouts and paramiko TripleDES warning

Make AI-chat SSH failures diagnosable and pooled-connection reuse robust

Memoize per-message markdown rendering in AI chat

Split backend/app.py into feature modules with a shared extensions kernel

### [DIAGNOSTICS]

Render sosreport log viewer when no journal or timestamps are available

Inline Red Hat fonts in diagnostics srcdoc frame

Skip unreadable log files in Log Viewer instead of failing load_tab

Fix diagnostics iframe showing its own scrollbar during load

Add pagination to CPU/Memory Accounting tabs, fix load-time layout jitter

Fix invisible current-page highlighting in diagnostics pagination

Fix diagnostics iframe not shrinking after content size decreases

Fix crash on SAR tabs with no CPU/disk/memory/network data

Fix 401 Unauthorized on Log Viewer/haproxy backend calls in diagnostics iframe

Fix dark theme readability of Services tab memory/task bar labels

Close unclosed &lt;script> tag in PCI devices diagnostics template

Fix Chart.js and malformed-template errors in diagnostics iframe

Fix diagnostics iframe CSS not loading in packaged builds

Sandbox DiagnosticsPage script execution to fix critical XSS

Fix 401 Unauthorized on sosreport log viewer and haproxy tabs

Resolve must-gather image dir for any registry via one shared helper

Deduplicate window-opener IPC handlers and getMachineId wrappers; remove dead backup files

### [TEAM]

Gate first-time device enrollment behind a shared secret (H4)

Harden renderer, Electron shell, SSH route and central server (H1-H5)

Fix compiler-critical react-hooks violations across seven files

Mark game players disconnected on every exit path, not just app auth

Expire abandoned games by disconnect duration, not game age

Replace native dialogs in game modes

Harden central-p2p-server against malformed Yjs messages crashing it

Sweep stale PyInstaller onefile temp dirs in run.sh; drop tracked central-p2p-server.tar.gz

Add getDocumentsMetadata() to avoid loading full content for document lists

Stop re-broadcasting full grid/quiz state on every timer tick

Split central-p2p-server/server.js into feature modules

Add per-client secret auth to central-p2p-server (fix machine_id spoofing)

### [SECURITY]

Override lodash-es to 4.18.1 to fix npm audit advisories

Harden Offline Mode after review; shorten settings description

Fix joi and js-yaml npm audit vulnerabilities

Close SSRF, injection, traversal, session and fan-out gaps (M1-M8)

Fix XSS and injection vulnerabilities found in security audit

Fix all 15 npm audit vulnerabilities (1 low, 1 moderate, 13 high)

Reuse SSH connections across workflow-node commands (ControlMaster)

Add shared-secret auth token to close unauthenticated local backend

### [SETTINGS]

Add Offline Mode (default on) blocking all outbound connections

Declutter the General settings tab

Restyle debug status bar as a bottom-right corner pill

Change first-run default UI zoom from 0.75 to 0.9

Add persisted UI Scale (zoom) control to Settings > General

### [UI]

Square off GTFOBins chips, always show Function edit/delete

Add page layout directives to PDF export: pagebreak, blankpage, centerpage

Replace hardcoded example IP with a generic placeholder in run scripts

Show upload confirmation preview in Media Library Upload tab

Unify active-item color in the utility More menu dropdown

Fix context menus rendering far from the cursor/button

Fix off-screen context menus in CompactSidebar

Make the sidebar visibility toggle truly global

Add sidebar toggle button and fix two CompactSidebar UI bugs

Lift CompactSidebar nav rail to z-40 so its flyouts clear sticky page content

Render confirmation dialogs above always-on-top floating widgets

Fix dark-theme contrast in ConfirmationModal's typed-confirmation input

Require typed confirmation phrase before wiping the database

Add tool search to ToolsSidebar using the sticky-pill sidebar pattern

Load quicktype target languages on demand in JsonToInterfaceTool

### [DESKTOP]

Remove auto-update, GitLab release links and CI configs

Enable webSecurity and proxy workflow HTTP requests through main process

Collapse File menu database items into a Database submenu

Add toggleable debug status bar (FPS, CPU, memory) to every window

Fix ui-settings.json writes to merge instead of clobbering the file

Switch packaged backend from PyInstaller onefile to onedir

Use socketio.run() in the packaged backend entrypoint

Ignore macOS AppleDouble (._*) resource-fork files

Add macOS support and port-in-use guard to run1.sh

Add macOS support and port-in-use guard to run2.sh; respect PORT env in backend/app.py

Scope self-signed certificate allowance to the configured central server

Remove dead firewall toggle IPC handlers (shell injection surface)

### [DEPLOY]

Pin backend build to Homebrew Python 3.13

Widen supply-chain cooldown window from 2 to 7 days

Fix npm audit vulnerabilities, upgrade build venv pip, add pip cooldown

Pin Containerfile to exact Node 24.18.0

Fix infinite "Image not found" spam and width=px parsing

Fix rootless-podman EACCES on clients.json and move server state out of the checkout

Wire Yjs encryption key + persistent data volume into deploy-podman.sh; remove unused local/systemd deployment scripts

Fix container image missing the modules split out of server.js

Fix Flask debug mode, sshpass argv exposure, and SSH host-key TOFU

### [TESTS]

Add reusable Linux container toolkit under tests/linux

Fix rebuild-test.sh backend build success check for onedir output

Fix two stale tests broken by the XSS/injection security audit

Extend diagnostics test driver: height-report recording, scrollbar/inner-scroll probes, Log Viewer helpers

Save reusable Playwright driver for live DiagnosticsPage testing

Fix npm audit vulnerabilities (7: 1 moderate, 6 high)

Force plain-text logs in yjs eviction test's spawned server

Add promise-based useConfirmation hook with modal interaction tests

Add tests/run-all.sh to run the whole test suite in one command

### [MISC]

Rebuild What's New on FloatingWindow and make releases local-only

Bump locked dependency versions

Bump transitive undici to fix GHSA-3wwx-pv8p-q78v

Show inherit targets on GTFOBins Inherit function chips

Make suid/capabilities context extras editable, show suid override

Polish Executables table: drop count column, search code too

Replace Functions/Contexts tables with pill pickers

Drop bundled GTFOBins dataset now that IndexedDB is seeded

Fix pagebreak/blankpage/centerpage landing position drifting downward

Add npm min-release-age supply-chain protection

Refactor Media Library: usage tracking, tags, filters, bulk delete

Export ZIP: per-category images/ folder instead of shared _media/, sanitize entry names

Sanitize spaces from Media Library filenames on upload

Make Sentence Builder group boundary box draggable

Support optional width sizing for Media Library attachment images

Add Sentence Builder tool

Fix unclamped DatePicker/DateTimePicker and add precise sizing

Show mapped plaintext letter in Substitution Cipher frequency list

Fix Substitution Cipher Reset Key to fully clear the grid

Enhance Substitution Cipher Key grid: shift badge and sorting

Add Caesar, Affine, and XOR cipher tools

Revert "Add Multi Decoder tool"

Add Multi Decoder tool

Fix white-on-white key input in Substitution Cipher tool

Add Substitution Cipher tool

Add Binary to String tool

Add Histogram and Morse Code tools

Prune stale optional lockfile entries

Clear the remaining mechanical lint rules - repo is now ESLint-clean

Delete remaining dead code flagged by no-unused-vars (267 -> 0)

Drop unused imports and unused catch bindings repo-wide

Finish react-hooks cleanup: all 210 compiler-lint findings resolved

Clear react-hooks refs long tail and first half of set-state-in-effect

Resolve react-hooks refs/immutability errors in twelve more files

Remove dead handlers and stale setter calls that referenced missing state

Scope ESLint globals correctly and exclude build artifacts

Accept legacy positional addNotification(message, type) calls

Debounce the command palette search trigger

Lazy-load tool components so ToolsPage stops bundling all 41 tools

Ignore .claude directory in eslint config to fix 8-minute lint runs

Add new backend modules to PyInstaller hiddenimports

Check for existing process on backend port before launching


## What's New in v2.5.5

_2026-07-26_

### [TEAM] Quiz Improvements

Added new Quiz game mode Grid.

Refactor the code for Quiz.

### [SETTINGS] Offline Mode

New Offline Mode switch in Settings > General, ON by default. While it is on the application makes no outbound network connections at all: Cloud Sync, Jira, Google Calendar, remote AI providers, URL fetching, WHOIS, update checks and workflow REST API / SSH nodes are refused with a clear message. Only connections to this machine (the local backend, a local Ollama) are allowed; links still open in your system browser.

The switch is enforced centrally in the desktop shell and the local backend, not just per feature, and a small cloud-off icon in the bottom-right corner (next to the FPS counter when that is enabled) shows when it is active. Turn it off in Settings to re-enable sync and the other network features; it applies immediately, no restart needed.

Fonts and the Diagnostics charts are now bundled with the app instead of being loaded from a CDN, so they work with Offline Mode on.


## What's New in v2.5.4

### [TEAM] AI Quiz

You can now upload documentation files to generate quiz questions.

Added optional topic field for "From URL" and "From File" modes. When generating questions from large documents or URLs, you can now specify a specific topic to focus on (e.g., "Installation", "Networking").

The AI will analyze your uploaded document or URL and create technical questions based on the actual content, perfect for testing knowledge on specific documentation or training materials.


## What's New in v2.5.3

### [DOCUMENTS] Sample Templates Added

Added sample templates to several tools to help you get started quickly.

Click the "Samples" button to load pre-configured examples and see how each tool works. Samples include common patterns for regex validation, JSON structures, SQL queries, and more.


## What's New in v2.5.2

### [DOCUMENTS] Documents Changes

Improved document creation workflow to be category-aware.

When creating a new document using the "Add New" button, it will now be created in the same category as the currently active document. If no document is selected, it defaults to the General category.

### [MISC] New Tools Added

Added three new tools to enhance your productivity:

IPv4 Subnet Calculator - Calculate subnet mask, network address, broadcast address, first/last host, total/usable hosts, IP class, and binary representation for IPv4 networks.

IPv6 Subnet Calculator - Calculate network address, first/last address, address type (Global Unicast, Link-Local, etc.), and binary representation for IPv6 networks. Supports both compressed and expanded IPv6 formats.

Cron Parser - Parse and understand cron expressions with human-readable descriptions, field breakdowns, and next execution times. Includes common examples and format help.

### [MISC] Timer Tools Enhancement

Added pause and resume functionality to Stopwatch and Countdown Timer tools.

You can now pause either tool mid-run and resume from where you left off, making it easier to manage timing tasks without losing your progress.


## What's New in v2.5.1

### [DESKTOP] Think Out of the Box

Added the ability to open Tools, Diagnostics, and Search pages in separate external windows.

Right-click on the Tools, Diagnostics, or Search icon in the sidebar and select "Open in External Window" to work with these pages independently while keeping the main window focused on Documents or other tasks.


## What's New in v2.5.0

### [CALENDAR] Calendar Sync Fixes

Fixed calendar sync to properly remove events deleted from Google Calendar.

Fixed all-day events appearing on wrong day due to timezone handling.

Calendar sync now only updates events within the viewed time range, preserving cached events from other months.

### [MISC] Tooling Around

Added new Tools page with 38+ developer utilities organized into 8 categories:

Calculate: Hash Calculator (MD5, SHA1, SHA256, SHA384, SHA512), SLA Calculator

Conversion: Base64, Color Converter, CSV/JSON, HTML to Markdown, JSON/YAML, XML to JSON, Number Base Converter, String Utilities, Time Format Converter

Encode/Decode: Backslash Escape, HTML Entities, JWT Decoder, URL Encoder/Decoder

Format: CSS, HTML, JSON, SQL Formatters

Generate: Barcode, CSR, JSON to TypeScript Interface, Lorem Ipsum, QR Code, UUID

Miscellaneous: Countdown Timer, Markdown Preview, Stopwatch, String Analyzer, Text Diff, URL Exploder

Networking: WHOIS Lookup

Validate: IBAN Validator, Regex Validator


## What's New in v2.4.21

### [DOCUMENTS] Document Editor

Shows IndexedDB content while Yjs is loading.

Update textarea when server content loads.


## What's New in v2.4.20

### [TEAM] Quiz-ed the Bugs!

Corrected "Correct Answer" not showing to all players when everyone answered.

Fixed Duplicate Quiz Invites.


## What's New in v2.4.19

### [DIAGNOSTICS] Log View-er

Filter logs within selected severity or process for more precise diagnostics. The new filters work seamlessly together to help you find exactly what you need.

Access from Diagnostics → sosreport → Log Viewer.

### [TEAM] Challenge your friends!

We have added cross-platform support for Quiz! Challenge your friends by sharing the link accessible from Web Browser.

Access from Quiz → Select Topic → Create a Lobby → Share Link (Web).

### [UI] Make it your own!

Customize your Jacarium sidebar with beautiful themes including Magma, Nebula, Vulkan, Sunset, and Aurora.

Access them from Application Settings → Theme Settings → Color Scheme to transform your sidebar with vibrant colour.
