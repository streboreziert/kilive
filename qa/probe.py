import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; tab = sys.argv[2] if len(sys.argv) > 2 else 'sch'
    vw, vh = (390, 844) if 'mobile' in sys.argv else (1440, 900)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': vw, 'height': vh}, device_scale_factor=1)
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~' + tab, wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        if tab == 'sch':
            pos = await pg.evaluate("""(()=>{ const v = Noeti.app.views.sch; const dl = v.dl[v.page]; const r = v.canvas.getBoundingClientRect();
               const side = document.querySelector('.live-side'); const sr = side && side.offsetParent ? side.getBoundingClientRect() : null;
               const cands = dl.pins.map(p => { const [x, y] = v.toScreen(p.x, p.y); return {x: r.left + x, y: r.top + y, p}; }).filter(q => q.x > r.left + 20 && q.y > r.top + 120 && q.x < (sr ? sr.left - 20 : r.right - 20) && q.y < r.bottom - 80);
               const q = cands[Math.floor(cands.length/2)]; return q ? {x: q.x, y: q.y, n: cands.length} : null })()""")
        else:
            pos = await pg.evaluate("""(()=>{ const v = Noeti.app.views.pcb; const r = v.canvas.getBoundingClientRect(); const B = v.B || v.board;
               const pads = (B.pads || B.data.pads || []).slice(0, 4000);
               const side = document.querySelector('.live-side'); const sr = side && side.offsetParent ? side.getBoundingClientRect() : null;
               const c = []; for (const pd of pads) { const x = pd.x != null ? pd.x : pd[1], y = pd.y != null ? pd.y : pd[2]; const [sx, sy] = v.toScreen(x, y); const X = r.left + sx, Y = r.top + sy; if (X > r.left + 20 && Y > r.top + 120 && X < (sr ? sr.left - 20 : r.right - 20) && Y < r.bottom - 80) c.push({x: X, y: Y}); }
               return c.length ? Object.assign(c[Math.floor(c.length/3)], {n: c.length}) : null })()""")
        print('click at', pos)
        if pos:
            await pg.mouse.move(pos['x'], pos['y']); await pg.wait_for_timeout(400)
            tip = await pg.evaluate("(()=>{const t=document.querySelector('.tip, .pv-tip, .sv-tip, .tooltip'); return t ? t.innerText.slice(0,200) : null})()")
            print('hover tip:', tip)
            await pg.mouse.click(pos['x'], pos['y']); await pg.wait_for_timeout(800)
            pr = await pg.evaluate("(()=>{const L=Noeti.live; return {n: L.probes.length, probes: L.probes.map(p=>({net:p.net, view:p.at&&p.at.view, label:p.label||p.name}))}})()")
            print('probes:', json.dumps(pr))
            card = await pg.evaluate("(()=>{const s=document.querySelector('.live-side'); return s && s.offsetParent ? s.innerText.slice(0,500) : 'side closed'})()")
            print('side:', card.replace('\n',' | '))
        await pg.screenshot(path=f'/tmp/claude-0/qa/probe-{bd}-{tab}{"-m" if vw<500 else ""}.png')
        print('\n'.join(logs[:10]))
        await b.close()
asyncio.run(main())
