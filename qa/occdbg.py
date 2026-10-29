import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, ref, z = sys.argv[1], sys.argv[2], float(sys.argv[3]); pts = json.loads(sys.argv[4])
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        await pg.evaluate("""([ref, z]) => { const v = Noeti.app.views.pcb, B = v.B; const f = B.fps.find(f => f.r === ref); v.zoomTo(f.x, f.y, z); v.draw(); }""", [ref, z])
        await pg.wait_for_timeout(1500)
        out = await pg.evaluate("""(pts) => { const v = Noeti.app.views.pcb, B = v.B, F = B._pcbFlow; const r = v.root.getBoundingClientRect(); const res = [];
          const dseg = (px, py, x1, y1, x2, y2) => { const dx = x2-x1, dy = y2-y1, L = dx*dx+dy*dy || 1; let t = ((px-x1)*dx+(py-y1)*dy)/L; t = Math.max(0, Math.min(1, t)); return Math.hypot(px-x1-t*dx, py-y1-t*dy); };
          for (const [cx, cy] of pts) { const [wx, wy] = v.toWorld(cx - r.left, cy - r.top); const hits = [];
            for (let s = 0; s < F.nseg; s++) { const S = F.segs; const d = dseg(wx, wy, S[s*6], S[s*6+1], S[s*6+2], S[s*6+3]); if (d < 0.12 && Math.abs(F.segI[s]) > 1e-6) hits.push({seg: s, layer: B.cu[S[s*6+5]] || S[s*6+5], net: F.nets ? F.segNet[s] : null, I: F.segI[s], d: +d.toFixed(3), from:[+S[s*6].toFixed(2), +S[s*6+1].toFixed(2)], to:[+S[s*6+2].toFixed(2), +S[s*6+3].toFixed(2)]}); }
            for (let k = 0; k < F.legI.length; k++) { const p = B.pads[F.legs[k*2]], f = B.fps[F.legs[k*2+1]]; const dd = Math.hypot(p[4]-wx, p[5]-wy); if (dd < 1.5 && (Math.abs(F.legI[k]) > 1e-6 || Math.abs(F.legSum[k]) > 1e-6)) hits.push({leg: k, kind: F.legKind[k], fp: f.r, pad: p[1], fpxy: [f.x, f.y], padxy: [p[4], p[5]], I: F.legI[k], d: +dd.toFixed(2)}); }
            res.push({at: [cx, cy], w: [+wx.toFixed(2), +wy.toFixed(2)], hits}); }
          return res; }""", pts)
        print(json.dumps(out))
        await b.close()
asyncio.run(main())
