"""Smoke check: open the editor page, report console errors, take a screenshot. usage: smoke.py name query [w h] [js]"""
import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    name, q = sys.argv[1], sys.argv[2]
    w = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
    h = int(sys.argv[4]) if len(sys.argv) > 4 else 900
    js = sys.argv[5] if len(sys.argv) > 5 else ''
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') and 'ERR_TUNNEL' not in m.text and 'fonts.g' not in m.text else None)
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto('http://localhost:8765/test-editor.html' + q, wait_until='load')
        await pg.wait_for_timeout(800)
        if js:
            r = await pg.evaluate(js)
            if r is not None: print('=>', r)
            await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'/tmp/claude-0/shots/{name}.png')
        print('\n'.join(logs) or 'no console errors')
        await b.close()
asyncio.run(main())
