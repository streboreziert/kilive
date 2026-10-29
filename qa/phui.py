import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:200]}') if m.type == 'error' and 'TUNNEL' not in m.text and 'fonts' not in m.text else None)
        await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui-explore.png')
        await pg.goto(URL + '#hackrf~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui-board.png')
        # open the prerendered photo from About
        await pg.click('.about-photo .ap-btn'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui-photo-pre.png')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        # render from the 3D view
        await pg.click('button:has-text("Photo")')
        for i in range(60):
            await pg.wait_for_timeout(2000)
            done = await pg.evaluate("!!document.querySelector('.ph-img') || !!document.querySelector('.ph-err')")
            if done: break
        await pg.wait_for_timeout(500)
        info = await pg.evaluate("(()=>{const n=document.querySelector('.ph-note'); const e=document.querySelector('.ph-err'); return (n&&n.textContent)+' | '+(e&&e.textContent)})()")
        print('dialog:', info)
        await pg.screenshot(path='/tmp/claude-0/qa/ui-photo-live.png')
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())
