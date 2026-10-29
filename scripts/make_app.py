#!/usr/bin/env python3
"""Makes the desktop launchers next to the project:

  KiLive.app              macOS: double-click; starts the local server (scripts/serve.py) and opens the app window
  Start KiLive.command    macOS: the same from a Terminal window (shows the server's messages)
  Start KiLive.bat        Windows
  start-kilive.sh         Linux

Run it once from a Terminal in this folder:   python3 scripts/make_app.py
It needs nothing but Python 3. On a Mac it also signs the app bundle (ad hoc) so Gatekeeper lets it open.
"""
import os, plistlib, shutil, stat, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
NAME = 'KiLive'

LAUNCH = '''#!/bin/bash
# KiLive: start the local server and open the app window. The server stops by itself after the window closes.
DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
PY=""
for c in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  osascript -e 'display dialog "KiLive needs Python 3, which this Mac does not have yet.\\n\\nOpen Terminal, type  python3  and press Return: macOS offers to install the command line tools. Then open KiLive again." buttons {"OK"} default button 1 with title "KiLive"'
  exit 1
fi
cd "$DIR" || exit 1
mkdir -p local-data
nohup "$PY" scripts/serve.py >> local-data/server.log 2>&1 &
exit 0
'''

COMMAND = '''#!/bin/bash
# KiLive from a Terminal window: the server's messages show here; close the window to stop it.
cd "$(dirname "$0")" || exit 1
exec python3 scripts/serve.py --keep
'''

BAT = '''@echo off
rem KiLive: start the local server and open the app window.
cd /d "%~dp0"
where py >nul 2>nul && (start "" /min py -3 scripts\\serve.py & exit /b)
where python >nul 2>nul && (start "" /min python scripts\\serve.py & exit /b)
echo KiLive needs Python 3 (python.org or the Microsoft Store). Press a key to close.
pause >nul
'''

SH = '''#!/bin/sh
cd "$(dirname "$0")" || exit 1
exec python3 scripts/serve.py "$@"
'''


def write(path, text, executable=False):
    with open(path, 'w', encoding='utf-8', newline='\n') as h:
        h.write(text)
    if executable:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def make_mac_app():
    app = os.path.join(ROOT, NAME + '.app')
    if os.path.isdir(app):
        shutil.rmtree(app)
    macos = os.path.join(app, 'Contents', 'MacOS')
    res = os.path.join(app, 'Contents', 'Resources')
    os.makedirs(macos)
    os.makedirs(res)
    write(os.path.join(macos, 'launch'), LAUNCH, executable=True)
    icon = os.path.join(HERE, 'app-icon.icns')
    if os.path.isfile(icon):
        shutil.copy(icon, os.path.join(res, 'app.icns'))
    info = {
        'CFBundleName': NAME, 'CFBundleDisplayName': NAME, 'CFBundleIdentifier': 'com.noeticompute.boards.desktop',
        'CFBundleVersion': '1.0', 'CFBundleShortVersionString': '1.0', 'CFBundlePackageType': 'APPL',
        'CFBundleExecutable': 'launch', 'CFBundleIconFile': 'app', 'LSMinimumSystemVersion': '11.0',
        'LSUIElement': True,   # the app is the browser window; no second Dock icon for the launcher
        'NSHighResolutionCapable': True,
    }
    with open(os.path.join(app, 'Contents', 'Info.plist'), 'wb') as h:
        plistlib.dump(info, h)
    write(os.path.join(app, 'Contents', 'PkgInfo'), 'APPL????')
    if sys.platform == 'darwin' and shutil.which('codesign'):
        subprocess.run(['codesign', '--force', '--deep', '--sign', '-', app], check=False)
        subprocess.run(['xattr', '-dr', 'com.apple.quarantine', app], check=False)
    return app


def main():
    made = [make_mac_app()]
    write(os.path.join(ROOT, 'Start ' + NAME + '.command'), COMMAND, executable=True); made.append('Start ' + NAME + '.command')
    write(os.path.join(ROOT, 'Start ' + NAME + '.bat'), BAT); made.append('Start ' + NAME + '.bat')
    write(os.path.join(ROOT, 'start-kilive.sh'), SH, executable=True); made.append('start-kilive.sh')
    for m in made:
        print('made', m)
    if sys.platform == 'darwin':
        print('\nDouble-click "%s.app" to start. Boards you save go to local-data/.' % NAME)


if __name__ == '__main__':
    main()
