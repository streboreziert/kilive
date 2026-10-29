import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error','warning') and 'fonts' not in m.text else None)
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#new', wait_until='networkidle')
        await pg.wait_for_timeout(2000)
        async with pg.expect_file_chooser() as fc:
            await pg.click('.cc-datasheet .btn.primary')
        ch = await fc.value
        await ch.set_files('/usr/share/doc/fonts-texgyre/qhv-info.pdf')
        for i in range(30):
            ok = await pg.evaluate("!!document.querySelector('.crop-wrap')")
            if ok: break
            await pg.wait_for_timeout(500)
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/shots/ds-pages.png')
        # drag a crop box
        box = await pg.evaluate("(()=>{const r=document.querySelector('.crop-wrap').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        x,y,w,h = box
        await pg.mouse.move(x+w*0.1, y+60); await pg.mouse.down(); await pg.mouse.move(x+w*0.7, y+300, steps=5); await pg.mouse.up()
        await pg.click('.ds-run .btn.primary')
        for i in range(40):
            hsh = await pg.evaluate('location.hash')
            if hsh.startswith('#draft-'): break
            await pg.wait_for_timeout(500)
        print('hash', hsh, await pg.evaluate("JSON.stringify(window.__lastJsonOpts)"))
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path='/tmp/claude-0/shots/ds-design.png')
        await pg.click('#tab-sim'); await pg.wait_for_timeout(600)
        await pg.click('#sim-run'); await pg.wait_for_timeout(8000)
        await pg.screenshot(path='/tmp/claude-0/shots/ds-sim.png')
        print(await pg.evaluate("(document.querySelector('.legend')||{}).innerText"))
        # debug flow
        await pg.fill('#dbg-text', 'VOUT reads 1.2 V')
        await pg.click('.dbg-form .btn.primary'); await pg.wait_for_timeout(15000)
        await pg.screenshot(path='/tmp/claude-0/shots/ds-debug.png', full_page=False)
        print(await pg.evaluate("(document.querySelector('.dbg-body')||{}).innerText"))
        print('\n'.join(logs[-20:]))
        await b.close()
asyncio.run(main())
