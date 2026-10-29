import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        # zoom to a busy part, enable the tool from the toolbar
        await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, B = v.B; const f = B.fps.find(f => /^U\\d/.test(f.r) && f.pads.length > 6) || B.fps[0]; v.zoomTo(f.x, f.y, 14); v.draw(); })()""")
        await pg.wait_for_timeout(800)
        await pg.click('#pane-pcb .probe-tool-btn'); await pg.wait_for_timeout(400)
        print('tool on:', await pg.evaluate("[Noeti.app.probeTool, Noeti.app.views.pcb.probeMode, Noeti.live.on]"))
        # find a visible track with a net
        pos = await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, B = v.B; const W = v.root.clientWidth, H = v.root.clientHeight; const r = v.root.getBoundingClientRect();
          const tr = B.pcb.tracks[B.cu[0]]; for (let k = 0; k + 5 < tr.length; k += 6) { if (!tr[k + 5]) continue; const mx = (tr[k] + tr[k + 2]) / 2, my = (tr[k + 1] + tr[k + 3]) / 2; const s = v.toScreen(mx, my); if (s[0] > 120 && s[1] > 120 && s[0] < W - 120 && s[1] < H - 120 && tr[k+4] >= 0.2) return [r.left + s[0], r.top + s[1], B.nets[tr[k + 5]]]; } return null; })()""")
        print('track at', pos)
        await pg.mouse.move(pos[0], pos[1]); await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/pt-1-hover.png')
        await pg.mouse.click(pos[0], pos[1]); await pg.wait_for_timeout(3500); print('zoom after:', await pg.evaluate('Noeti.app.views.pcb.view.s.toFixed(1)'))
        print('after click:', await pg.evaluate("[Noeti.live.on, Noeti.live.probes.map(p => p.label || p.name), Noeti.app.probeTool]"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/pt-2-live.png')
        # a second probe on a pad
        pos2 = await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, B = v.B; const W = v.root.clientWidth, H = v.root.clientHeight; const r = v.root.getBoundingClientRect();
          for (const p of B.pads) { if (!p[10] || p[2] === 2 || !(p[9] & 1)) continue; const s = v.toScreen(p[4], p[5]); if (s[0] > 120 && s[1] > 120 && s[0] < W - 420 && s[1] < H - 120) return [r.left + s[0], r.top + s[1], B.fps[p[0]].r + '.' + p[1]]; } return null; })()""")
        print('pad at', pos2)
        await pg.mouse.click(pos2[0], pos2[1]); await pg.wait_for_timeout(1500)
        print('probes:', await pg.evaluate("Noeti.live.probes.map(p => p.label || (p.ref + '.' + p.pin))"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/pt-3-two.png')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        print('after esc:', await pg.evaluate("[Noeti.app.probeTool, Noeti.app.views.pcb.probeMode]"))
        # P key with nothing selected toggles the tool while live
        await pg.evaluate("Noeti.select([], [])"); await pg.wait_for_timeout(200)
        await pg.keyboard.press('p'); await pg.wait_for_timeout(300)
        print('after P:', await pg.evaluate("[Noeti.app.probeTool]"))
        # 3D: probe there too
        await pg.evaluate("location.hash = location.hash.replace('~pcb', '~3d')"); await pg.wait_for_timeout(4000)
        print('3d tool:', await pg.evaluate("[Noeti.app.probeTool, !!document.querySelector('#pane-3d .probe-tool-btn.on')]"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/pt-4-3d.png')
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
