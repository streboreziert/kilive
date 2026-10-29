import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: occl.py board ref zoom tag - live PCB zoomed on a part
async def main():
    bd, ref, z, tag = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=2)
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        info = await pg.evaluate("""([ref, z]) => { const v = Noeti.app.views.pcb, B = v.B; const f = B.fps.find(f => f.r === ref) || B.fps.find(f => /^U\\d/.test(f.r)); v.zoomTo(f.x, f.y, z); v.draw(); const F = B._pcbFlow; return {ref: f.r, air: (B.pcb.air||[]).length/5, airOnly: F && F.airOnly, cu: B.cu}; }""", [ref, z])
        print(info)
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}.png')
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
