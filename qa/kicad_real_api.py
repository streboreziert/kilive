"""The plugin against a real KiCad: real pcbnew module, real board, a real unsaved edit, the installed package.

    sudo apt install kicad        (KiCad 7+; the pcbnew module comes with it, for the system python3)
    python3 kicad-plugin/build_pcm.py --dir /tmp/pcm
    /usr/bin/python3 -u qa/kicad_real_api.py /tmp/pcm /path/to/board.kicad_pcb
Checks: the plugin's base class is KiCad's ActionPlugin; the board KiCad hands over includes an edit that is
not saved; the app shows that edit; the file on disk is untouched. Exit code 1 on failure.
"""
import asyncio, importlib.util, os, sys, webbrowser
import pcbnew
PKG, BOARD = sys.argv[1], sys.argv[2]
fails = []
board = pcbnew.LoadBoard(BOARD)
values = [fp.GetValue() for fp in board.GetFootprints()]
old = next(v for v in values if v and v[0].isdigit())
new = 'EDITED-' + old
for fp in board.GetFootprints():
    if fp.GetValue() == old: fp.SetValue(new)
pcbnew.GetBoard = lambda: board
opened = []
webbrowser.open = lambda u, *a, **k: opened.append(u) or True
plug = os.path.join(PKG, 'plugins')
spec = importlib.util.spec_from_file_location('noetipkg', os.path.join(plug, '__init__.py'), submodule_search_locations=[plug])
pkg = importlib.util.module_from_spec(spec); sys.modules['noetipkg'] = pkg; spec.loader.exec_module(pkg)
from noetipkg.kilive import KiLive as NoetiBoards
print('KiCad', pcbnew.GetBuildVersion(), '| ActionPlugin is KiCad\'s:', NoetiBoards.__mro__[1] is pcbnew.ActionPlugin)
p = NoetiBoards(); p.defaults(); p.Run()
if not opened: fails.append('no browser opened')
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 900}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(opened[0], wait_until='networkidle'); await pg.wait_for_timeout(5000)
        n = await pg.evaluate("Noeti.app.cur && Noeti.app.cur.B && Noeti.app.cur.B.fps.length")
        await pg.evaluate("location.hash = location.hash.replace(/~[a-z0-9]+$/, '~bom')"); await pg.wait_for_timeout(1200)
        t = await pg.evaluate('document.body.innerText')
        print('parts', n, '| unsaved edit shown:', new in t, '| disk untouched:', new not in open(BOARD).read())
        if not n: fails.append('no board')
        if new not in t: fails.append('unsaved edit missing')
        if new in open(BOARD).read(): fails.append('file on disk changed')
        if errs: fails.append('page errors')
        await b.close()
asyncio.run(main())
print('FAIL: ' + '; '.join(fails) if fails else 'PASS')
sys.stdout.flush(); os._exit(1 if fails else 0)
