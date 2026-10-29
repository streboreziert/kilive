# Contributing

## Issues

| Type | Include |
| --- | --- |
| Wrong view or simulation result | board link (URL with `#…`), expected vs. observed value, screenshot |
| Import failure | smallest `.kicad_pcb` / `.kicad_sch` that reproduces it, KiCad version |
| Board request | repository URL, license |

## Pull requests

1. Build and serve: `python3 scripts/build_site.py && cd dist && python3 -m http.server 8000`
2. Edit `app/js/`. No build step; rebuild `dist/` and reload.
3. Check:
   ```sh
   for f in app/js/*.js; do node --check "$f"; done
   pip install playwright && python3 -m playwright install chromium
   (cd dist && python3 -m http.server 8766 &)
   python3 qa/static_smoke.py http://localhost:8766/ rp2040-guide,glasgow
   ```
4. One change per pull request. State how it was tested.

CI runs the same checks.

## Rules

- Style: match the file. Two-space indent, `'use strict'`, one IIFE per file on `window.Noeti`.
- No runtime dependencies or CDN loads. The app must run offline from one static folder.
- Bundled boards require an open license. `python3 tools/license_audit.py --prune` enforces it and regenerates `BOARDS.md`.

Contributions are licensed under MIT.
