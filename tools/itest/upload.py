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
            await pg.click('.cc-upload .btn.primary')
        ch = await fc.value
        await ch.set_files(sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0/zips/rp2040.zip')
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/shots/u-progress.png')
        for i in range(40):
            h = await pg.evaluate('location.hash')
            if h.startswith('#draft-'): break
            await pg.wait_for_timeout(500)
        print('hash', h)
        await pg.wait_for_timeout(3000)
        await pg.screenshot(path='/tmp/claude-0/shots/u-3d.png')
        await pg.click('#tab-sim'); await pg.wait_for_timeout(800)
        await pg.screenshot(path='/tmp/claude-0/shots/u-sim.png')
        s = await pg.evaluate("[...document.querySelectorAll('.sugg')].map(x=>x.innerText.replace(/\\n/g,' ')).join(' | ')")
        print('suggestions', s)
        await pg.click('.sugg >> nth=0'); await pg.wait_for_timeout(800)
        await pg.screenshot(path='/tmp/claude-0/shots/u-sim-sec.png')
        await pg.click('#sim-run'); await pg.wait_for_timeout(5000)
        await pg.screenshot(path='/tmp/claude-0/shots/u-sim-run.png')
        print(await pg.evaluate("(document.querySelector('.legend')||{}).innerText"))
        # save
        await pg.click('#save-btn'); await pg.wait_for_timeout(500)
        await pg.click('.modal-foot .btn.primary'); await pg.wait_for_timeout(6000)
        print('after save', await pg.evaluate("location.hash + ' ' + [...window.__store.keys()].filter(k=>k.startsWith('library')).length"))
        await pg.screenshot(path='/tmp/claude-0/shots/u-saved.png')
        # leave and reopen from db
        await pg.evaluate("location.hash='explore'"); await pg.wait_for_timeout(1200)
        await pg.click('.user-card'); await pg.wait_for_timeout(4000)
        print('reopened', await pg.evaluate("location.hash + ' parts=' + (document.querySelector('#loading')||{}).hidden"))
        await pg.screenshot(path='/tmp/claude-0/shots/u-reopen.png')
        await pg.click('#tab-files'); await pg.wait_for_timeout(600)
        await pg.click('.export >> nth=0'); await pg.wait_for_timeout(2500)
        print('saved files', await pg.evaluate("JSON.stringify(window.__saved)"), await pg.evaluate("window.__savedData && (window.__savedData.size || window.__savedData.length)"))
        print('\n'.join(logs[-20:]))
        await b.close()
asyncio.run(main())
