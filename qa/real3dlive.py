import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: real3dlive.py board [yawdeg] [pitchdeg] [zoom]
async def main():
    bd = sys.argv[1]
    yaw = float(sys.argv[2]) if len(sys.argv) > 2 else None
    pitch = float(sys.argv[3]) if len(sys.argv) > 3 else None
    zoom = float(sys.argv[4]) if len(sys.argv) > 4 else 1
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        print('software:', await pg.evaluate("(() => { const v = Noeti.app.views.v3d; const s = [v.software, v.realOn, v.renderer]; v.setReal(true, true); return s; })()"))
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; if (!p) return; const a=L.analysisFor(p); const src=Noeti.analysis.program(a); L.fwm.runScript(p, src); L.realTime();})()")
        await pg.wait_for_timeout(int(sys.argv[5]) if len(sys.argv) > 5 else 6000)
        await pg.evaluate(f"""(() => {{ const v = Noeti.app.views.v3d;
          {'v.cam.yaw = ' + str(yaw) + ' * Math.PI / 180;' if yaw is not None else ''}
          {'v.cam.pitch = ' + str(pitch) + ' * Math.PI / 180;' if pitch is not None else ''}
          v.cam.dist /= {zoom}; v.setLight('{sys.argv[6] if len(sys.argv) > 6 else 'studio'}'); v.dirty = true; }})()""")
        await pg.wait_for_timeout(2500)
        st = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d, R = v.real, L = Noeti.live; let lit = 0, sel = 0; if (R && R.state) for (let o = 3; o < R.state.length; o += 4) { if (R.state[o] & 2) lit++; if (R.state[o] & 1) sel++; }
          return { lit, sel, leds: (L && L.leds || []).filter(d => d.lvl > 0.05).map(d => d.ref + ':' + d.lvl.toFixed(2)).slice(0, 12), pix: L && L.pix ? L.pix.size : 0, pixv: L && L.pix ? [...L.pix].slice(0, 4).map(([r, c]) => r + ':' + c.join(',')) : [], t: L && L.t }; })()""")
        print(bd, json.dumps(st))
        tm = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d, gl = v.gl, px = new Uint8Array(4); const run = () => { const t0 = performance.now(); for (let i = 0; i < 3; i++) { v.cam.yaw += 0.003; v.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } return Math.round((performance.now() - t0) / 3); };
          const a = run(); v.realOn = false; const b = run(); v.realOn = true; return { real: a, old: b, w: v.canvas.width, h: v.canvas.height }; })()""")
        print('frame ms', tm)
        await pg.screenshot(path=f'/tmp/claude-0/qa/rlive-{bd}.png', timeout=90000)
        print('\n'.join(logs[:12]))
        await b.close()
asyncio.run(main())
