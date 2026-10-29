#!/bin/bash
# KiLive from a Terminal window: the server's messages show here; close the window to stop it.
cd "$(dirname "$0")" || exit 1
exec python3 scripts/serve.py --keep
