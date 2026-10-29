import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def paste(pg, text):
    await pg.evaluate("""(t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); }""", text)
async def main():
    p1 = open('/tmp/claude-0/plugtest/payload1.txt').read(); p2 = open('/tmp/claude-0/plugtest/payload2.txt').read()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
        await pg.goto(URL + '#new', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-0-new.png')
        await paste(pg, p1); await pg.wait_for_timeout(600)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-1-modal.png')
        print('modal:', await pg.evaluate("document.querySelector('.modal') && document.querySelector('.modal').innerText.slice(0, 300)"))
        await pg.click('.modal-foot .btn.primary'); await pg.wait_for_timeout(4000)
        print('hash:', await pg.evaluate("location.hash"), 'parts:', await pg.evaluate("Noeti.app.cur && Noeti.app.cur.B && Noeti.app.cur.B.fps.length"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-2-board.png')
        await paste(pg, p2); await pg.wait_for_timeout(600)
        print('modal2:', await pg.evaluate("document.querySelector('.modal') && document.querySelector('.modal').innerText.slice(0, 400)"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-3-modal2.png')
        await pg.click('.modal-foot .btn.primary'); await pg.wait_for_timeout(4000)
        print('diff btn hidden:', await pg.evaluate("document.querySelector('#diff-btn') && document.querySelector('#diff-btn').hidden"), await pg.evaluate("document.querySelector('#diff-btn') && document.querySelector('#diff-btn').title"))
        await pg.click('#diff-btn'); await pg.wait_for_timeout(600)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-4-diff.png')
        print('diff:', await pg.evaluate("document.querySelector('.modal') && document.querySelector('.modal').innerText.slice(0, 600)"))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        await pg.click('#kicad-btn'); await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-5-menu.png')
        print('menu:', await pg.evaluate("document.querySelector('.menu-pop') && document.querySelector('.menu-pop').innerText"))
        await pg.keyboard.press('Escape')
        # simulation deck
        r = await pg.evaluate("""async () => { const B = Noeti.app.cur.B; const m = Noeti.simtab.wholeBoard(B); const e = new Noeti.LiveSim(m.circuit, m.sim, {}, {}, { rampTime: 0 }); for (let i = 0; i < 10; i++) e.advance(0.002, 50); const d = Noeti.kicadLink.spiceDeck(e, 'blinker'); const p = Noeti.kicadLink.simPackage(e, 'blinker'); return { lib: d.lib, cir: d.cir.slice(0, 1500), zip: p.zip.length, n: d.volts.length }; }""")
        print('LIB:\n' + r['lib']); print('CIR:\n' + r['cir']); print('zip bytes', r['zip'])
        # plugin zip
        z = await pg.evaluate("async () => { const z = await Noeti.kicadLink.pluginZip(); const z2 = await Noeti.kicadLink.pluginIpcZip(); return [Array.from(z), z2.length]; }")
        open('/tmp/claude-0/qa/plugin.zip', 'wb').write(bytes(z[0])); print('plugin zip', len(z[0]), 'ipc', z[1])
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
