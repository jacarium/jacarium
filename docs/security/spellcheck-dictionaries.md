# Spell-checking dictionaries

What the desktop app ships for its spell checker on Windows and Linux, where it comes from, and how it was checked.
The one place this is pinned is [`electron/spellcheck-dictionaries.json`](../../electron/spellcheck-dictionaries.json);
this page is the record behind it.

## Why they are shipped

Electron's spell checker uses Hunspell dictionaries on Windows and Linux (macOS uses the system's NSSpellChecker,
which needs nothing). Out of the box, Chromium looks for `<sessionData>/Dictionaries/<language>-<version>.bdic`
and, when the file is not there, downloads it from Google's CDN (`redirector.gvt1.com`) on the first run: an
outbound request that nothing in Jacarium declared, from an app that is offline by default (SECURITY.md,
"Running Jacarium securely"). Since this change the dictionaries are part of the installer, and the download is
pointed at a local `file:` URL that cannot be fetched, so a language that is not shipped fails locally instead of
reaching out.

How it works (`electron/spellcheck.cjs`, run first thing when the app is ready, before any window or session):

1. the shipped files (`resources/dictionaries/` in the packaged app, `build/dictionaries/` in a checkout) are
   checked against the sha256 pinned in the manifest and copied into the profile's `Dictionaries` directory - a
   file that does not match is refused, one that is already there and matches is kept, an older copy (an earlier
   CDN download of the same name) is replaced;
2. the default session is created and `setSpellCheckerDictionaryDownloadURL` is set to
   `file:///nonexistent/jacarium-spellcheck-dictionaries/` (process-wide: it covers every session);
3. the configured languages are kept to the shipped ones (en-US when none of them is shipped), so Electron never
   has a reason to look for another file;
4. the first window is created only once Electron has reported every language's dictionary initialized (capped
   at 3 seconds). Chromium hands a dictionary that finishes loading to the renderers that exist at that moment
   and skips one whose process is still launching, which then never gets it: with the file already in place the
   load is so quick that a window created in the same tick ended up without spell checking at all (seen under
   Linux; a dictionary downloaded seconds later never hit this). `tests/electron-spellcheck-live.test.mjs`
   types a misspelling into the real app and checks it is flagged.

The profile picker (a throwaway session) gets the URL only and runs with spell checking off.

## Provenance

The files are taken unchanged from the `hunspell_dictionaries.zip` asset that Electron publishes with every
release, for the exact release in `package-lock.json`; the manifest refuses to serve a different one (the fetch
script red-flags a manifest whose Electron version is not the installed one, and `--repin` is the way to move it).

| | |
|---|---|
| Electron release | [v45.2.3](https://github.com/electron/electron/releases/tag/v45.2.3), asset `hunspell_dictionaries.zip` uploaded 2026-11-04 17:23 UTC (7.2 days old when pinned on 2026-11-12: the ordinary lane, the default seven days). Before, [v45.2.2](https://github.com/electron/electron/releases/tag/v45.2.2)'s asset of 2026-11-03 (the security lane, `--min-age-days 2`), [v45.2.1](https://github.com/electron/electron/releases/tag/v45.2.1)'s asset of 2026-10-30, [v45.1.0](https://github.com/electron/electron/releases/tag/v45.1.0)'s of 2026-10-27 and [v42.11.17](https://github.com/electron/electron/releases/tag/v42.11.17)'s of 2026-10-20 (the history below) |
| Asset sha256 | `f4692e1bc615b542478c8cf4c5d3424ea2d9c891076a8f218b0da0ba06b8d5c8`, 34,144,925 bytes - the digest GitHub reports for the asset (`digest` in the release API) and the sha256 of the download agree |
| Uploader | the Electron release bot (`sudowoodo-release-uploader[bot]`), like every asset of the release |
| `en-US-10-2.bdic` | `b0d80e6b6c5491879365e176ecbd98074602a663429bcfcfb0a5a8375c051f13`, 451,982 bytes - SCOWL (Kevin Atkinson), permissive (Chromium 156 carries the 10-2 revision of the three English word lists; 42's were 10-1) |
| `en-GB-10-2.bdic` | `e014c23d2215f093205343b9b8805e17c8d8e115d314d93fd5ba51eadf05cff2`, 452,008 bytes - SCOWL, permissive |
| `en-AU-10-2.bdic` | `13427b9828773291cde00ba266a58fd5110ba6f1d4b29ed86b49f4b3afdf0a39`, 453,801 bytes - SCOWL, permissive |
| `cs-CZ-3-0.bdic` | `fd31ba12d939c43cc71d5a00441df9bace5edcdeca735ade0e84e5f10cd410d6`, 3,108,527 bytes - GPL-2.0 |
| `sk-SK-3-0.bdic` | `c4ef7e950bda27505c9103cd72abc01cd8d3f1a36d85708b9cc6d8e7dd230547`, 1,668,425 bytes - GPL-2.0 / LGPL-2.1 / MPL-1.1 |
| Licence texts | `LICENSE` `d63c6240d6f6330a025aade63d317d7ff04f95fc3325fe6aea3848ca452f64ea`, `COPYING` `cde91164e09e33e94e1db4529aa77f89bc0c392b1ed138d689c66dfbd11d9701`, and `COPYING.MIT`, `COPYING.MPL`, `COPYING.GPL3`, `COPYING.LGPL`, `COPYING.LESSER`, `COPYING.Apache` as the zip carries them (every hash in the manifest) |

The `.bdic` files are Chromium's compiled form of the Hunspell `.dic` / `.aff` sources kept in
[chromium/deps/hunspell_dictionaries](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/),
where `README_<language>.txt` holds each dictionary's full copyright notice. The packaged app ships the zip's
licence texts and a `NOTICE.txt` (`electron/spellcheck-dictionaries-NOTICE.txt`) naming each dictionary's source
and licence next to the dictionaries, under `resources/dictionaries/`. The dictionaries are data files, not code
linked into the app; the GPL-licensed Czech and Slovak word lists are redistributed unchanged under their own
licences beside an AGPL-3.0 application.

Nothing is tracked in git: the two larger dictionaries exceed the privacy scan's 1 MB file rule, and a binary blob
in the history would be hard to review. The files are fetched when a Linux or Windows package is built
(`rebuild.sh`, `npm run electron:build`) and verified every time, whether just downloaded or already there.

## The checks, and how to repeat them

```bash
node scripts/fetch-spellcheck-dictionaries.mjs            # fetch what is missing or wrong, verify everything
node scripts/fetch-spellcheck-dictionaries.mjs --check    # verify build/dictionaries only, no network
node tests/electron-spellcheck-dictionaries.test.mjs      # the manifest, the module, the script, the packaging
node tests/electron-spellcheck-live.test.mjs              # the real app: no request leaves for a dictionary,
                                                          #   the checker flags a misspelling
```

What the script checks, each a red flag with exit 1: the manifest's Electron version is the installed one; the
zip is fetched over https from github.com only and its sha256 is the pinned one; every file taken out of it has
the pinned sha256 and size before it is written; what is already in `build/dictionaries` verifies the same way.
At run time `electron/spellcheck.cjs` checks each file's sha256 again before copying it into the profile.

## Moving to a new Electron release

After Electron is bumped in `package-lock.json` (the usual 7-day rule applies to it), run

```bash
node scripts/fetch-spellcheck-dictionaries.mjs --repin
```

It reads the installed release from the GitHub API, red-flags an asset younger than 7 days (`--force` only on
the maintainer's explicit decision - say so here), downloads the zip, compares its sha256 with the digest GitHub
reports, hashes the five dictionaries (by language, so a bumped `<major>-<minor>` in a file name is picked up)
and the licence files, and rewrites the manifest. Then run the script again to fetch the files, run the two tests,
and add a row to the table above with the new release, its date and the hashes.

## History

- 2026-11-03: first pinned, to Electron v42.11.17 (the release in use), four languages: en-US, en-GB, cs-CZ, sk-SK.
- 2026-11-03: en-AU added from the same pinned asset (the maintainer's request), five languages.
- 2026-11-04: re-pinned to Electron v45.1.0's asset with the move to Electron 45 (42 left Electron's support window
  when 45.0.0 was released on 2026-10-21: only the latest three majors get security fixes). `--repin` after
  `npm install electron@^45.1.0`: the zip's digest as GitHub reports it, 7.5 days old; the three English
  dictionaries moved from the 10-1 to the 10-2 revision (new hashes above), Czech and Slovak and every licence
  text are byte for byte the files of the previous pin. The stale 10-1 files are removed from build/dictionaries
  by the fetch (files not in the manifest), so a packaged app carries the manifest's files alone.
- 2026-11-05: re-pinned to Electron v45.2.1's asset with the security-lane move to 45.2.1 (Chromium
  156.0.8078.75; docs/security/urgent-updates.md). `--repin --min-age-days 2` (the lane's floor; the asset was
  5.1 days old): the zip's digest as GitHub reports it changed (a new zip, `edaeccd0…`), every file inside is
  byte for byte the file of the 45.1.0 pin - the five dictionaries and the licence texts keep their hashes.
- 2026-11-06: re-pinned to Electron v45.2.2's asset with the security-lane move to 45.2.2 (Chromium
  156.0.8078.80; docs/security/urgent-updates.md). `--repin --min-age-days 2` (the asset was 2.2 days old): a
  new zip digest (`1b0a3ce8…`), every file inside byte for byte the 45.2.1 pin's.
- 2026-11-12: re-pinned to Electron v45.2.3's asset with the ordinary move to 45.2.3 (backported upstream
  fixes, no advisory; the seven-day rule met on 2026-11-11). `--repin` at the default seven days (the asset,
  uploaded 2026-11-04 17:23 UTC, was 7.2 days old): a new zip digest (`f4692e1b…`), every file inside byte for
  byte the 45.2.2 pin's.
