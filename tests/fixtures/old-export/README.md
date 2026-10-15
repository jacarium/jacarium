# Export files from before the rename

Synthetic fixtures for `tests/import-old-export.test.mjs`: Export Database
files written by the app under its previous name (Support Console 3.0.1, the
code at commit 3b34c4a, before "Rename the app to Jacarium"). The rename kept
no fallback reads of the old database, storage or file names, so these files
prove the one supported route: export before, Import Database after.

| File | What it is |
| --- | --- |
| `support-console-3.0.1-format2.json` | `collectExportData()` of src/utils/exportDatabase.js (formatVersion 2: tasks per Taskwarrior instance) over a synthetic database: 3 documents (one embeds `attachment:diagram.png`, carried in `media` as a data URL), 2 categories, a document template, a JQL template, an engine template, a workflow, a board with 3 cards, an instance with 4 tasks, a custom report, a calendar template, an SSH command, an OpenShift template, a custom grid and quiz, GTFOBins rows and 3 localStorage keys. |
| `support-console-2.6.0-format1.json` | The same data in the older flat-tasks format (formatVersion 1, `tasks` at the top level) as the 2.6 releases wrote it. |
| `support-console-3.0.1-account-backup.json` | `backend/account_data.build_export()` (the server's account backup, offered before "Delete all my data on the server"): 2 documents, a category, a board and card, an instance and task, one media file. |

Generated once with a throwaway script that bundled the pre-rename modules
with esbuild over fake-indexeddb (no backend, no real data: example hosts,
invented names, a 1x1 PNG). The export format itself names no application,
so the files are byte-for-byte what a user's export of that version holds.
Do not regenerate them with current code - their point is the old origin.
