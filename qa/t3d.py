import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--enable-unsafe-swiftshader','--use-angle=swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle')
        await pg.wait_for_timeout(3000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("(()=>{const c=document.querySelector('#pane-3d canvas'); const r=c.getBoundingClientRect(); return [r.left,r.top,r.width,r.height]})()")
        print('canvas', r)
        found = None
        for fy in [0.45,0.5,0.4,0.55,0.35,0.6]:
            for fx in [0.3,0.35,0.4,0.45,0.5,0.25,0.2]:
                x = r[0]+r[2]*fx; y = r[1]+r[3]*fy
                await pg.mouse.move(x, y); await pg.wait_for_timeout(250)
                t = await pg.evaluate("(()=>{const t=Noeti.app.v3dUI&&Noeti.app.v3dUI.tip; return t && !t.hidden ? t.innerText : null})()")
                if t and ('net' in t) and 'Pour' not in t:
                    found = (x, y, t); break
            if found: break
        print('tip:', found and found[2].replace('\n',' | '))
        if found:
            await pg.mouse.click(found[0], found[1]); await pg.wait_for_timeout(1200)
            print('probes', await pg.evaluate("Noeti.live.probes.map(p=>p.label+' '+(p.at&&p.at.view))"))
            await pg.mouse.move(found[0], found[1]+1); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'/tmp/claude-0/qa/t3d-{bd}.png')
        print('\n'.join(logs[:10]))
        await b.close()
asyncio.run(main())
