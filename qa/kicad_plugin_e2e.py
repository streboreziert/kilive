"""End-to-end test of the KiLive KiCad plugin package, with stand-ins for pcbnew and wx.

    python3 kicad-plugin/build_pcm.py --dir /tmp/pcm
    cp -r "/tmp/otter/HW v1.4" /tmp/proj
    python3 -u qa/kicad_plugin_e2e.py /tmp/pcm /tmp/proj
"""
import asyncio, os, sys, types, time, re
PKG, PROJ = sys.argv[1], sys.argv[2]
BOARD = os.path.join(PROJ, 'OtterPill.kicad_pcb')
opened = []
# --- stand-ins for what KiCad provides
pcbnew = types.ModuleType('pcbnew')
class ActionPlugin:
    def register(self): self.defaults(); pcbnew.registered.append(self)
pcbnew.ActionPlugin = ActionPlugin; pcbnew.registered = []
class FakeBoard:
    def GetFileName(self): return BOARD
pcbnew.GetBoard = lambda: FakeBoard()
pcbnew.GetBuildVersion = lambda: '8.0.6'
EDIT = {'from': '3k3', 'to': '4k7'}
def SaveBoard(path, board, skip):   # the editor state: the saved file plus an unsaved edit
    open(path, 'w').write(open(BOARD).read().replace('(fp_text value "%s"' % EDIT['from'], '(fp_text value "%s"' % EDIT['to']))
    return True
pcbnew.SaveBoard = SaveBoard
sys.modules['pcbnew'] = pcbnew
import webbrowser; webbrowser.open = lambda u, *a, **k: opened.append(u) or True
sys.path.insert(0, PKG)
import plugins                       # what KiCad does with the PCM package's plugins/ folder
plugin = pcbnew.registered[0]
print('registered:', plugin.name, '| toolbar button:', plugin.show_toolbar_button, '| icon exists:', os.path.isfile(plugin.icon_file_name))
from playwright.async_api import async_playwright
fails = []
os.makedirs('shots', exist_ok=True)
async def bom_text(pg):
    await pg.evaluate("location.hash = location.hash.replace(/~[a-z0-9]+$/, '~bom')"); await pg.wait_for_timeout(1200)
    return await pg.evaluate("document.body.innerText")
async def main():
    plugin.Run()
    print('opened browser at:', opened)
    if not opened: fails.append('browser not opened'); return
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1400, 'height': 900}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(opened[0], wait_until='networkidle'); await pg.wait_for_timeout(5000)
        parts = await pg.evaluate("Noeti.app.cur && Noeti.app.cur.B && Noeti.app.cur.B.fps.length")
        print('1 first open: hash', await pg.evaluate('location.hash'), 'parts', parts)
        t = await bom_text(pg)
        print('  unsaved edit 4k7 shown:', '4k7' in t, '| 3k3 gone:', '3k3' not in t)
        if not parts or '4k7' not in t: fails.append('first open / unsaved edit')
        await pg.screenshot(path='shots/plugin-bom.png')
        # 2: press the button again with another unsaved edit: the open tab updates, no new tab
        EDIT['to'] = '5k6'; n_open = len(opened); plugin.Run(); await pg.wait_for_timeout(5000)
        t = await bom_text(pg)
        print('2 button again: new tab opened:', len(opened) > n_open, '| 5k6 shown:', '5k6' in t)
        if len(opened) > n_open or '5k6' not in t: fails.append('second press update')
        # 3: save in KiCad (file changes on disk): the tab updates
        src = open(BOARD).read().replace('(fp_text value "100k"', '(fp_text value "220k"'); time.sleep(0.05); open(BOARD, 'w').write(src)
        await pg.wait_for_timeout(5000)
        t = await bom_text(pg)
        print('3 saved on disk: 220k shown:', '220k' in t)
        if '220k' not in t: fails.append('disk save update')
        # 4: live simulation on the plugin-served board
        await pg.evaluate("location.hash = location.hash.replace(/~[a-z0-9]+$/, '~pcb')"); await pg.wait_for_timeout(1500)
        await pg.wait_for_selector('#live-btn'); await pg.wait_for_timeout(800); await pg.click('#live-btn'); await pg.wait_for_timeout(6000)
        rails = await pg.evaluate("document.body.innerText.match(/SUPPLY RAILS[\\s\\S]{0,140}/)?.[0]||''")
        print('4 live:', rails.replace('\n', ' | ')[:140])
        await pg.screenshot(path='shots/plugin-live.png')
        # 5: requests with a foreign Host header are refused (DNS rebinding guard)
        import urllib.request
        base = opened[0].split('#')[0]
        req = urllib.request.Request(base + '_kicad/project', headers={'Host': 'evil.example'})
        try: urllib.request.urlopen(req); fails.append('foreign host allowed'); print('5 foreign host: ALLOWED')
        except Exception as e: print('5 foreign host refused:', getattr(e, 'code', e))
        if errs: fails.append('page errors: ' + '; '.join(errs[:3]))
        await b.close()
asyncio.run(main())
print('FAIL: ' + '; '.join(fails) if fails else 'PASS')
os._exit(1 if fails else 0)
