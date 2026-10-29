import asyncio, sys, json, os
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
def read(d): return {f: open(os.path.join(d, f)).read() for f in os.listdir(d) if f.endswith(('.kicad_pcb', '.kicad_sch', '.kicad_pro'))}
async def main():
    f1, f2 = read('/tmp/claude-0/plugtest/proj'), read('/tmp/claude-0/plugtest/proj2')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.add_init_script("""window.__fs = { files: {}, t: 1000 };
          const fileH = name => ({ kind: 'file', name, getFile: async () => { const f = window.__fs.files[name]; return new File([f.text], name, { lastModified: f.t }); } });
          window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'blinker-proj', entries: async function* () { for (const n of Object.keys(window.__fs.files)) yield [n, fileH(n)]; } });""")
        await pg.goto(URL + '#new', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("(f) => { for (const [k, v] of Object.entries(f)) window.__fs.files[k] = { text: v, t: 1000 }; }", f1)
        await pg.click('.cc-kicad .btn'); await pg.wait_for_timeout(4000)
        print('after link:', await pg.evaluate("[location.hash, Noeti.app.cur && Noeti.app.cur.B && Noeti.app.cur.B.fps.find(f => f.r === 'R2').v, !!Noeti.kicadLink.link]"))
        print('chip:', await pg.evaluate("document.querySelector('#link-chip') && [document.querySelector('#link-chip').hidden, document.querySelector('#link-chip').innerText]"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-6-linked.png')
        # "save in KiCad"
        await pg.evaluate("(f) => { for (const [k, v] of Object.entries(f)) window.__fs.files[k] = { text: v, t: 2000 }; }", f2)
        await pg.wait_for_timeout(5000)
        print('after save:', await pg.evaluate("[Noeti.app.cur.B.fps.find(f => f.r === 'R2').v, Noeti.app.cur.user.lastDiff && Noeti.diffSummary(Noeti.app.cur.user.lastDiff.d)]"))
        print('chip:', await pg.evaluate("document.querySelector('#link-chip').innerText"))
        await pg.click('#link-chip'); await pg.wait_for_timeout(300)
        print('unlinked:', await pg.evaluate("[!!Noeti.kicadLink.link, document.querySelector('#link-chip').hidden]"))
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
