# Website screenshots

Reproducible marketing screenshots of the app, filled with **synthetic** content:
example.test hosts, fictional teammates (Alex, Sam, Priya, Jordan), invented
dates in October 2026. Nothing comes from a real profile, server, customer or
employer. The pictures land in `~/Desktop/jacarium-screenshots/` by default,
with an `index.md` that lists each file, a caption suggestion and the feature
it shows.

```sh
node scripts/screenshots/capture.mjs                      # everything, Jacaranda dark, desktop + phone, plus the neutral contrast shot
node scripts/screenshots/capture.mjs --out /tmp/shots     # another output directory
node scripts/screenshots/capture.mjs --theme neutral      # the Dark (neutral) theme (files get a -neutral suffix)
node scripts/screenshots/capture.mjs --theme light        # the light theme (-light suffix)
node scripts/screenshots/capture.mjs --theme all          # all three sets
node scripts/screenshots/capture.mjs --contrast light     # the contrast shot in another theme (none to skip it)
node scripts/screenshots/capture.mjs --only documents,kanban --no-phone
node scripts/screenshots/capture.mjs --phone              # only the phone shots
node scripts/screenshots/capture.mjs --keep               # leave the servers and Chrome running (debugging)
```

## Prerequisites

- `npm install` done (Vite, the app's dependencies, `pngjs` is not needed).
- `backend/venv` (`cd backend && pip install -r requirements.txt` into a venv) -
  the Flask backend runs in accounts mode on **:8080** (or the next free port
  when 8080 is taken, e.g. by the desktop app; `--backend-port` pins one); the
  Vite dev server needs **:5173** (the backend's CORS allow-list).
- Google Chrome or Chromium (`CHROME_BIN=/path/to/chrome` for another binary;
  see `tests/helpers/live-documents-app.mjs`).
- `task` (Taskwarrior 3) on the PATH, for the Tasks page.
- The synthetic sosreport: `python3 tests/fixtures/diagnostics-mock/generate.py`
  (writes `tests/fixtures/diagnostics-mock/out/`, git-ignored), for Diagnostics.

One run takes about three minutes.

## What a run does

1. Starts the backend with a throwaway `HOME` under the system temp directory
   (`JACARIUM_AUTH_MODE=accounts`, its own accounts database, reports root and
   Taskwarrior data). The owner's `~/.jacarium.env`, `~/.task`, app profiles
   and home server are never read: every `JACARIUM_*` variable is dropped from
   the environment and `HOME` points at the scratch directory.
2. Starts the Vite dev server and headless Chrome with a throwaway profile
   through `tests/helpers/live-documents-app.mjs` (the live tests' driver).
3. Creates the throwaway administrator from `content.mjs` (`ACCOUNT`),
   screenshots the sign-in page, signs in, and seeds the account's database
   through the app's own Dexie module (`/src/db/database.js`): document
   categories, documents, a Kanban board, a workflow, two calendars with a
   week of events, a Taskwarrior instance plus saved filters; the tasks
   themselves are created with the `task` CLI in the account's scratch
   `~/.task`; the Robin conversation is stored in `localStorage` the way the
   page stores it.
4. Walks the pages and captures PNGs at 1440x900 @2x (and 393x852 @3x for the
   phone shots) with `Page.captureScreenshot`; the PNGs carry no metadata.
5. Stops Chrome, Vite and the backend and deletes the scratch directory
   (unless `--keep`).

Three requests are stubbed inside the page (never sent anywhere): the AI
model list (`/api/ai/models`, so the stored conversation shows against a local
Ollama model - no provider is ever called), the Google Calendar auth status
(`/api/calendar/auth-status`, so the week shows the seeded cached events
without the set-up banner) and the calendar sync that would follow. The
sidebar headers' central-server dot (red while no central server is linked)
is hidden by a stylesheet. Everything else is the app as it runs.

## Shots (`--only` ids)

| id | file | shows |
|----|------|-------|
| `sign-in` | `11-sign-in.png` | the browser build's sign-in page (brand hero, tagline, version) |
| `documents` | `01-documents.png` | Documents: categories, open tabs, a runbook in preview (headings, bash, table, checklist) |
| `editor` | `02-documents-editor.png` | the same runbook as Markdown source with the line-number gutter |
| `split` | `02-documents-split.png` | the split view: the runbook's source in the left pane, the architecture document's preview (Mermaid diagram) in the right pane - the state "Open in Right Side" produces; a document cannot be in both panes, so this is two documents |
| `mermaid` | `03-documents-mermaid.png` | a Mermaid flowchart rendered in preview, with a table below |
| `kanban` | `04-kanban.png` | a three-column board with tags, priorities, assignees and due dates (inner sidebar hidden so the whole board fits) |
| `tasks` | `05-tasks.png` | Taskwarrior tasks: an active one with its timer, pending ones with project, priority, tags, due dates, urgency; saved filters |
| `workflow` | `06-workflow-builder.png` | the builder canvas: Begin Play -> REST API -> Comparison -> Branch -> Result / webhook, with a note |
| `chat` | `07-robin-chat.png` | Robin: a stored Q&A about a stuck Kubernetes rollout |
| `diagnostics` | `08-diagnostics-processes.png` | Diagnostics, Processes tab of the synthetic sosreport (charts) |
| `log-viewer` | `08-diagnostics-log-viewer.png` | Diagnostics, Log Viewer with the journal loaded (severity charts and rows) |
| `calendar` | `09-calendar-week.png` | Calendars, a populated week with an all-day event |
| `about` | `10-settings-about.png` | Settings > About (mark, tagline, versions, website) |
| `whats-new` | `12-whats-new.png` | the What's New window (categorised list) over Documents |
| `phone-sign-in` | `phone-sign-in.png` | sign-in at phone width |
| `phone-documents` | `phone-documents.png` | a document in preview at phone width |
| `phone-kanban` | `phone-kanban.png` | the board at phone width |

The light Mermaid shot of the set is `--theme light --only mermaid --contrast none`
(`03-documents-mermaid-light.png`).

Themes: `dark` is the Jacaranda dark (the default, no suffix), `neutral` the
grey Dark (neutral) variant (`-neutral` suffix), `light` the light theme
(`-light` suffix); `--theme all` captures all three sets. A run also adds one
**contrast shot**, the Documents page in a second theme - `--contrast`,
default `neutral`, so a default run ends with `01-documents.png` (Jacaranda)
and `01-documents-neutral.png` (Dark neutral); `--contrast none` skips it.

## Determinism

The content is fixed (dates around 2026-10-12..18, fixed titles, fixed node
positions); the account, database ids and Taskwarrior UUIDs are recreated
each run but never appear in the pictures. What does follow the clock: the
Tasks page's `today` badges, the annotation timestamp, the active task's timer
and the calendar's current-time line (the week shown is the one containing
today - re-date `EVENTS` in `content.mjs` when the month moves on).

## Editing the content

`content.mjs` holds everything the pictures show. Keep it generic: no company
or customer names, no real hostnames (use `*.example.test`), no ticket or case
numbers. `bash scripts/privacy-scan.sh --tracked` runs over it like over any
other tracked file.
