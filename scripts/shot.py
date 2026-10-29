import asyncio, sys, json, os
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview.html'
async def main():
    targets = sys.argv[1:] or ['']
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        for t in targets:
            name, _, h = t.partition('=')
            await pg.goto(URL + ('#' + h if h else ''), wait_until='networkidle')
            await pg.wait_for_timeout(int(json.loads(os.environ.get('WAIT', '3500'))))
            await pg.screenshot(path=f'/tmp/claude-0/shots/{name or "home"}.png')
        print('\n'.join(logs[-30:]))
        await b.close()
asyncio.run(main())
