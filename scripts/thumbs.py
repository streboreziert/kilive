import asyncio, json
from playwright.async_api import async_playwright
CSS = """.viewer-card{position:fixed!important;inset:0!important;z-index:999;border-radius:0!important;border:0!important}
.vc-tabs,.ov-tl-stack,.ov-tr,.ov-bottom,.ov-help,.selcard,.topbar{display:none!important}
.vc-body{height:100vh!important}
html,body,#app,main,.board-page,.pane-3d,.vc-body,.viewer-card{background:transparent!important;box-shadow:none!important}
body *{visibility:hidden!important} .gl-host,.gl-host *{visibility:visible!important}"""
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 960, 'height': 600}, device_scale_factor=1)
        import os
        for r in idx:
            if os.path.exists(f"/home/claude/noeti/app/thumbs/{r['id']}.webp"): continue
            bd = r['boards'][0]
            await pg.goto(f"http://localhost:8765/preview.html#{r['id']}~{bd['id']}~3d", wait_until='networkidle')
            await pg.add_style_tag(content=CSS)
            await pg.wait_for_timeout(4000)
            await pg.evaluate("""(()=>{const v=Noeti.app.views.v3d; v.resize(); v.fit(true); v.anim && v.anim(performance.now()+1e6);
                const st=Noeti.app.cur.B.stats; const under=st.bottom>st.top*1.5;
                v.cam.yaw=under?Math.PI-0.42:-0.42; v.cam.pitch=under?-0.78:0.78; v.cam.dist*=(under?1.08:0.9); v.dirty=true;})()""")
            await pg.wait_for_timeout(2500)
            png = f"/tmp/claude-0/{r['id']}.png"
            await pg.screenshot(path=png, omit_background=True)
            from PIL import Image
            Image.open(png).save(f"/home/claude/noeti/app/thumbs/{r['id']}.webp", 'WEBP', quality=84, method=6)
            print('thumb', r['id'])
        await b.close()
asyncio.run(main())
