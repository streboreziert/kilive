import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
BOARDS = sys.argv[1:] or ['glasgow~glasgow', 'hackrf~hackrf-one', 'bus-pirate~bus-pirate', 'rp2040-guide~rp2040-guide', 'anyon-e~power', 'anyon-e~motherboard', 'anyon-e~audio']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#explore', wait_until='networkidle')
        for bd in BOARDS:
            await pg.evaluate(f"location.hash='{bd}~sim'")
            for i in range(40):
                if await pg.evaluate("!!document.querySelector('.sim-head') && document.querySelector('#loading').hidden"): break
                await pg.wait_for_timeout(500)
            sug = await pg.evaluate("[...document.querySelectorAll('.sugg:not(.sel)')].map(x=>x.innerText.replace(/\\n/g,' '))")
            print(bd, '|', ' ; '.join(sug))
            for k in range(min(3, len(sug))):
                await pg.click(f'.sugg:not(.sel) >> nth={k}'); await pg.wait_for_timeout(500)
                info = await pg.evaluate("(document.querySelector('.sim-sec')||{}).innerText")
                rows = await pg.evaluate("[...document.querySelectorAll('.simrow .what')].map(x=>x.innerText).join(',')")
                import time; t=time.time()
                await pg.click('#sim-run')
                for i in range(60):
                    if await pg.evaluate("!document.querySelector('#sim-run').disabled"): break
                    await pg.wait_for_timeout(250)
                dt=time.time()-t
                res = await pg.evaluate("((document.querySelector('.legend')||document.querySelector('.sim-err')||{}).innerText||'').replace(/\\n/g,' ')")
                print('   ', sug[k][:40], '::', info.replace('\n',' ')[:90], '| rows', rows, '|', res[:160], f'| {dt:.1f}s')
            await pg.screenshot(path=f'/tmp/claude-0/shots/cs-{bd.split("~")[0]}.png')
        print('\n'.join(logs[-20:]))
        await b.close()
asyncio.run(main())
