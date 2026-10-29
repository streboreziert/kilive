# Developing KiLive

Everything is plain HTML, CSS and JavaScript with no build step for the app itself, plus Python 3 (standard library only)
for the import pipeline and helper scripts.

## Three ways the same app runs

| where | entry | storage for your library, stars, comments |
| --- | --- | --- |
| Static website (GitHub Pages, any web server) | `scripts/build_site.py` -> `dist/index.html` | IndexedDB in the browser (`scripts/browser-runtime.js`) |
| Desktop app | `start-kilive.sh`, `Start KiLive.command` (macOS), `Start KiLive.bat` (Windows) | JSON files under `local-data/` (`scripts/serve.py` + `scripts/local-runtime.js`) |
| claude.ai artifact | `app/index.html` published with the Artifact tool | the claude.ai shared database (stars, comments and the library are shared between viewers) |

The app reaches storage through `window.claude.use('db' | 'user' | 'downloads')` (`N.caps.use` in `app/js/social.js`).
Each runtime above provides that object; with none present the app still works and keeps stars in localStorage only.

## Layout


```
app/                 the web app: this folder is what gets published (index.html + js/ + data/ + photos/ + thumbs/)
  index.html         the page: markup and CSS; the script list at the bottom is the load order
  js/                one file per concern (see "Code map" below)
  data/              one board per file: <repo>__<board>__<version>.json.gz.txt (gzip, base64) + .meta.json; index.json lists them
                     the plain .json and .json.gz next to them are the import pipeline's intermediates (not loaded by the page)
  photos/, thumbs/   rendered board photos (webp) for the catalogue
  preview.html       app/index.html wrapped in the host's page skeleton, for opening locally (scripts/mkpreview.sh makes it)
  preview-mock.html  the same with a local stand-in for the claude.ai runtime (scripts/mock.js) - what the tests load
  test-*.html        stand-alone pages for the schematic editor and the layout generator
datasheet/           the datasheet -> reference design reader (datasheet2kicad's browser build): shell.html, app_all.js, pdf.js
                     scripts/mkdatasheet.py builds it into app/datasheet.html; the app shows it in a window (New board -> Read a
                     datasheet) and the extracted circuit comes back as a drawn board. The reader uses your own API key, or manual mode.
kicad-plugin/        "Send to KiLive": the KiCad plugin sources
  swig/              action plugin for KiCad 6-9 (pcbnew Python API) - packaged as a PCM zip by the page
  ipc/               plugin for the KiCad 9/10 IPC API (kipy) - plugin.json + main.py
  build.py           embeds the sources into app/js/kicadplugin-src.js (the page zips them on demand)
tools/               import pipeline (Python 3, no dependencies): KiCad files -> app/data
  sexpr.py, kicad_pcb.py, kicad_sch.py   parsers for .kicad_pcb / .kicad_sch (KiCad 6+)
  classify.py, checks.py                 part classification, design checks, BOM lines
  build.py, import2.py                   import from cloned repos (expects the clones under ~/boards and ~/boards2)
  boards2/                               the candidate list and its validation notes
  jsport/                                tests of the JS importer (app/js/kicad-import.js) against the Python parsers
  itest/, editortest/, layoutgen/        older integration tests (Playwright)
scripts/             build helpers
  build_site.py      the static website -> dist/  (with browser-runtime.js: library and stars in IndexedDB)
  serve.py           the desktop app: a local server with local-runtime.js (library and stars as JSON under local-data/)
  mkpreview.sh       writes app/preview.html and app/preview-mock.html
  mock.js            local stand-in for window.claude (db, user, downloads) used by preview-mock.html
  thumbs.py, shot.py, sweep.py, act.py   screenshot and sweep helpers (Playwright)
qa/                  the test scripts used while building (Playwright, headless Chromium with software GL)
  smoke.py           opens boards in every tab and reports page errors      python3 qa/smoke.py glasgow,thunderscope
  railsall.py        every board's supply rails against the voltage its name states (the simulation census)
  uishots.py, exshot.py, probetool.py, probesch.py, noai.py, kicade2e.py, revtest.py, cmptest.py, linktest.py ...
  plugtest/          the KiCad plugin run against stand-in pcbnew / kipy modules
```

## Run it locally

```
python3 scripts/build_site.py && cd dist && python3 -m http.server 8000   # the static site: http://localhost:8000
python3 scripts/serve.py                                                   # the desktop app
sh scripts/mkpreview.sh                       # test pages: after any change to app/index.html
python3 scripts/mkdatasheet.py                # after any change under datasheet/
cd app && python3 -m http.server 8765         # then open http://localhost:8765/preview-mock.html
```

The tests expect that server on port 8765:

```
pip install playwright && python3 -m playwright install chromium
python3 qa/smoke.py glasgow,thunderscope,jumperlessv5
python3 qa/railsall.py out.json "" 1500       # all boards; prints the rails that are off
```

## Publish

**GitHub Pages:** `.github/workflows/site.yml` builds `dist/`, runs `qa/static_smoke.py` and deploys on every push to
`main`. Turn it on once under Settings -> Pages -> Source: GitHub Actions.

**claude.ai artifact:** the page is published with the Artifact tool: `index.html` is the page, everything else under `app/` goes in `files`
(paths relative to `app/`). `preview*.html` and `test-*.html` are not published. The stored capability declaration
(db rules for stars/comments/downloads/catalog/library, downloads, user profile) is carried forward by omitting
`capabilities`.

## Code map (app/js, in load order)

| file | what |
| --- | --- |
| util.js | helpers: el(), fmt, store, loadJSON (gzip/base64), icons, menus, toasts |
| board.js | Board: parsed board data, nets, pads, outline, `bodies()` (3D body selection) |
| gl3d.js, photo.js | WebGL 3D viewer and the 2K photo renderer |
| pcbview.js, schview.js | PCB and schematic canvases: layers, selection, probe tool, live overlays |
| panels.js | BOM, Checks, Files panels |
| social.js, library.js | stars, comments, downloads; the shared library (db) with revisions |
| ds2k-engine.js | circuit helpers: value parsing, expressions, sim cleaning |
| kicad-import.js | KiCad 6+ file importer in the browser (upload, paste, plugin payload) |
| layout-gen.js, scheditor.js, designer.js | drawn boards: schematic editor, layout generation, Design tab |
| partmodels.js | chip behaviour library: what pins do (translators, gates, chargers, USB parts …) |
| simulate.js | board -> circuit; chip guessing (regulators, converters, op-amps, switches); sources and loads |
| livesim.js | the solver: sparse MNA, backward Euler, Newton; element models |
| chipdb.js, devices*.js, emu-*.js, firmware.js | processors: pins, peripherals, AVR / RP2040 / ARM / RISC-V emulation, Arduino-style runtime |
| analysis.js, copperflow.js | board analysis, current paths on the copper |
| liveview.js, livepanel.js, actions.js | live mode: colours, dots, probes, scope, rails; the side panel; board actions |
| boarddiff.js | revision diff |
| kicadplugin-src.js, kicadlink.js | plugin download, "From KiCad" import, live folder sync, ngspice export |
| datasheet.js | the datasheet reader window and the hand-over of its circuit into a drawn board |
| create.js, app.js | New board page; the application shell (routes, tabs, selection, live, KiCad menu) |

## Opening from GitHub

`app/js/github.js`: `N.gh.parse` (links → owner/repo/ref/path), `N.gh.list` (one call to the git trees API),
`N.gh.open` (pick project, fetch its files from raw.githubusercontent.com, hand them to `N.create.importFiles`).
Route: `#gh/owner/repo[@ref][/path]` in `app.js`. Test: `/qa` has no network test; stub `api.github.com` and
`raw.githubusercontent.com` with Playwright routes.

## Board library and licenses

`app/data/index.json` lists the bundled example boards; `app/data/github.json` lists the other projects as GitHub links
(`python3 tools/split_library.py` chooses which are bundled; only permissive or attribution licenses are allowed). Only boards whose source repository states a license are bundled;
`python3 tools/license_audit.py` regenerates `BOARDS.md` (the attribution table) and `--prune` drops any board without
a license (recorded in `tools/unlicensed.json`). Run it after every import.

## Known gaps

- The ARM / RISC-V emulators, `devices.js` and `chipdb.js` are generated bundles; their sources (`emu/`) are not in this
  repository yet, so edit the bundles directly for now.
- `datasheet/test_*.js` and `tools/jsport/*.js` expect example files and board clones outside the repository.
- Several `qa/` scripts write screenshots to fixed paths under `/tmp`; `qa/static_smoke.py` is the one CI runs.
