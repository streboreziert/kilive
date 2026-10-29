"""Screenshot app/test-layout.html for each test circuit (Playwright + chromium/swiftshader).
usage: python3 shots.py [circuit ...] [--view=both|2d|3d] [--extra=query] [--size=WxH] [--tag=suffix]"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = 'http://localhost:8765/test-layout.html'
ALL = ['example', 'ldo', '555', 'opamp', 'npn', 'mcu', 'unknown', 'stm32']

async def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opt = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--'))
    names = args or ALL
    view = opt.get('view', 'both')
    w, h = map(int, opt.get('size', '1600x900').split('x'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        for n in names:
            pg = await b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1)
            logs = []
            pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
            url = f'{BASE}?c={n}&view={view}' + ('&' + opt['extra'] if 'extra' in opt else '')
            await pg.goto(url, wait_until='networkidle')
            await pg.wait_for_function('window.__ready === true', timeout=20000)
            await pg.wait_for_timeout(int(opt.get('wait', '2500')))
            path = f'/tmp/claude-0/shots/layout-{n}{opt.get("tag", "")}.png'
            await pg.screenshot(path=path)
            print(path, '\n'.join(logs))
            await pg.close()
        await b.close()

asyncio.run(main())
