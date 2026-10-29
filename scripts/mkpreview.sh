#!/bin/sh
# Wrap app/index.html in the same skeleton the artifact host adds, so the page can be opened locally.
#   preview.html       - the page as published
#   preview-mock.html  - the same with scripts/mock.js in front: a local stand-in for the claude.ai runtime (db, user, downloads)
# Usage: scripts/mkpreview.sh   (from anywhere; paths are relative to this script)
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
cd "$ROOT/app" || exit 1
HEAD='<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui;background:#fafaf7}img{max-width:100%%}[hidden]{display:none!important}</style></head><body>'
{ printf "$HEAD"; cat index.html; printf '</body></html>'; } > preview.html
{ printf "$HEAD"; printf '<script>'; cat "$HERE/mock.js"; printf '</script>'; cat index.html; printf '</body></html>'; } > preview-mock.html
echo "wrote app/preview.html and app/preview-mock.html"
