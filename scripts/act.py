import asyncio, sys, os
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/' + os.environ.get('PAGE','preview.html')
# usage: act.py name hash "js;js" [width height]
async def main():
    name, h, js = sys.argv[1], sys.argv[2], sys.argv[3]
    w = int(sys.argv[4]) if len(sys.argv) > 4 else 1440
    ht = int(sys.argv[5]) if len(sys.argv) > 5 else 1000
    scheme = os.environ.get('SCHEME', 'light')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': w, 'height': ht}, device_scale_factor=1, color_scheme=scheme)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if 'ERR_TUNNEL' not in m.text and '404' not in m.text else None)
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + h, wait_until='networkidle')
        await pg.wait_for_timeout(int(os.environ.get('WAIT', '5000')))
        for step in [s for s in js.split(';;') if s.strip()]:
            if step.startswith('WAIT '):
                await pg.wait_for_timeout(int(step[5:])); continue
            if step.startswith('CLICK '):
                await pg.click(step[6:]); await pg.wait_for_timeout(600); continue
            if step.startswith('MOUSE '):
                x, y = map(float, step[6:].split(','))
                await pg.mouse.click(x, y); await pg.wait_for_timeout(800); continue
            if step.startswith('HOVER '):
                x, y = map(float, step[6:].split(','))
                await pg.mouse.move(x, y); await pg.wait_for_timeout(500); continue
            if step.startswith('SHOT '):
                await pg.screenshot(path=f'/tmp/claude-0/shots/{step[5:]}.png'); continue
            if step.startswith('FULL '):
                await pg.screenshot(path=f'/tmp/claude-0/shots/{step[5:]}.png', full_page=True); continue
            r = await pg.evaluate(step)
            if r is not None: print('=>', r)
            await pg.wait_for_timeout(700)
        await pg.screenshot(path=f'/tmp/claude-0/shots/{name}.png')
        print('\n'.join(logs[-30:]))
        await b.close()
asyncio.run(main())
