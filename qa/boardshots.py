import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else 'bp'; w = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
    tabs = sys.argv[4].split(',') if len(sys.argv) > 4 else ['3d', 'pcb', 'sch', 'bom', 'checks', 'files']
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': w, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        for t in tabs:
            await pg.goto(URL + '#' + bd + ('' if '~' in bd else '~') + '~' + t, wait_until='networkidle'); await pg.wait_for_timeout(3500 if t == '3d' else 2000)
            await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-{t}.png')
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-full.png', full_page=True)
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
