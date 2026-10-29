import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#anyon-e~motherboard~pcb~v1', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(4000)
        info = await pg.evaluate("""(() => { const L = Noeti.live, B = L.B; const f = B.fp('U21');
          const pads = f.pads.map(pi => { const p = B.pads[pi]; return [p[1], p[14], B.nets[p[10]], L.padI('U21', p[1])]; });
          return { u21: [f.v, f.fp, f.x, f.y, f.s], pads, procs: (L.procs || []).map(p => p.ref + ' ' + p.value), vmax: L.vmax, speed: L.speed, t: L.engine.t,
            models: [...L.models].slice(0, 40) }; })()""")
        print(json.dumps(info, indent=1)[:4000])
        # zoom the PCB view onto U21
        await pg.evaluate("(() => { const v = Noeti.app.views.pcb; const f = Noeti.live.B.fp('U21'); v.zoomTo(f.x, f.y, 8); })()")
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path='/tmp/claude-0/qa/repro-pcb-u21.png')
        # the bottom side around the USB20_HOST1_DN track
        pos = await pg.evaluate("""(() => { const B = Noeti.live.B; const n = B.findNet('USB20_HOST1_DN'); const a = B.pcb.tracks['B.Cu']; for (let k = 0; k < a.length; k += 6) if (a[k+5] === n) return [a[k], a[k+1]]; return null; })()""")
        print('dn track at', pos)
        if pos:
            await pg.evaluate(f"(() => {{ const v = Noeti.app.views.pcb; v.setFlip(true); v.zoomTo({pos[0]}, {pos[1]}, 30); }})()")
            await pg.wait_for_timeout(2500)
            await pg.screenshot(path='/tmp/claude-0/qa/repro-pcb-dn.png')
        print('\n'.join(logs[:10]))
        await b.close()
asyncio.run(main())
